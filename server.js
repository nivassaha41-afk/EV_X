require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

// Serve the frontend without exposing server configuration files such as .env.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/:page.html', (req, res, next) => {
  const filePath = path.join(__dirname, `${req.params.page}.html`);
  if (!fs.existsSync(filePath)) return next();
  return res.sendFile(filePath);
});

app.get('/backend.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'backend.js'));
});

const {
  DB_HOST = 'localhost',
  DB_PORT = '3306',
  DB_USER = 'root',
  DB_PASS = '',
  DB_NAME = 'evcharge_db',
  JWT_SECRET = 'change_this_secret',
  PORT = 8080
} = process.env;

let pool;
let storageMode = 'mysql';
const dataDir = path.join(__dirname, 'data');
const usersDataFile = path.join(dataDir, 'users.json');

function ensureDataFile() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(usersDataFile)) {
    fs.writeFileSync(usersDataFile, '[]', 'utf8');
  }
}

async function readUsersFile() {
  ensureDataFile();
  const raw = fs.readFileSync(usersDataFile, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('users.json must contain an array');
  }
  return parsed;
}

async function writeUsersFile(users) {
  ensureDataFile();
  fs.writeFileSync(usersDataFile, JSON.stringify(users, null, 2), 'utf8');
}

async function initDB() {
  try {
    pool = mysql.createPool({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASS,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    const conn = await pool.getConnection();
    try {
      const escapedDbName = String(DB_NAME).replace(/`/g, '``');
      const createDbSql = `CREATE DATABASE IF NOT EXISTS \`${escapedDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`;
      await conn.query(createDbSql);
    } finally {
      conn.release();
    }

    pool = mysql.createPool({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASS,
      database: DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        evID VARCHAR(64) NOT NULL UNIQUE,
        fullName VARCHAR(255),
        chassisNumber VARCHAR(255),
        vehicleNumber VARCHAR(255),
        email VARCHAR(255),
        password VARCHAR(255),
        mobileNumber VARCHAR(64),
        registeredAt DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const [userColumns] = await pool.query('SHOW COLUMNS FROM users');
    const existingUserColumns = new Set(userColumns.map((column) => column.Field));
    const missingUserColumns = {
      email: 'VARCHAR(255)',
      password: 'VARCHAR(255)'
    };
    for (const [columnName, columnDefinition] of Object.entries(missingUserColumns)) {
      if (!existingUserColumns.has(columnName)) {
        await pool.query(`ALTER TABLE users ADD COLUMN ${columnName} ${columnDefinition}`);
      }
    }
 
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recharges (
        id INT AUTO_INCREMENT PRIMARY KEY,
        evID VARCHAR(64) NOT NULL,
        userId INT NULL,
        amount DECIMAL(10,2) NOT NULL,
        method VARCHAR(64),
        coins INT DEFAULT NULL,
        description VARCHAR(255),
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Charging sessions table for hardware IoT integration
    await pool.query(`
      CREATE TABLE IF NOT EXISTS charging_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        evID VARCHAR(64) NOT NULL,
        userId INT NULL,
        stationId VARCHAR(32) DEFAULT 'STATION-01',
        status ENUM('active','completed','cancelled') DEFAULT 'active',
        startTime DATETIME DEFAULT CURRENT_TIMESTAMP,
        endTime DATETIME NULL,
        currentAmps DECIMAL(6,2) DEFAULT 0,
        voltage DECIMAL(6,2) DEFAULT 230,
        totalKWh DECIMAL(8,3) DEFAULT 0,
        cost DECIMAL(10,2) DEFAULT 0,
        duration INT DEFAULT 0,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    storageMode = 'mysql';
    console.log('Using MySQL for user storage');
  } catch (error) {
    storageMode = 'file';
    pool = null;
    console.warn('MySQL unavailable, using local JSON storage instead:', {
      code: error.code,
      message: error.message,
      host: DB_HOST,
      port: DB_PORT,
      database: DB_NAME
    });
    ensureDataFile();
  }
}

function generateEVID(vehicleNo = '', chassisNo = '', fullName = '') {
  const seed = `${vehicleNo}${chassisNo}${fullName}${Date.now()}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const randomPart = String(Math.floor(1000 + Math.random() * 9000)).padStart(4, '0');
  const id = `EVX-${(seed || 'AUTH').substring(0, 4)}-${randomPart}`;
  return id;
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  const token = auth.slice(7);
  try {
    const data = jwt.verify(token, JWT_SECRET);
    req.user = data;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

app.post('/api/register', async (req, res) => {
  const { fullName, chassisNumber, vehicleNumber, email, mobileNumber } = req.body || {};
  const cleanFullName = String(fullName || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanMobile = String(mobileNumber || '').trim().toUpperCase();
  const cleanVehicle = String(vehicleNumber || '').trim().toUpperCase();
  const cleanChassis = String(chassisNumber || '').trim().toUpperCase();

  if (!cleanMobile && !cleanEmail) {
    return res.status(400).json({ error: 'Mobile number or email address is required' });
  }

  try {
    let user = null;

    // 1. Always attempt MySQL Save / Update if pool is connected
    if (storageMode === 'mysql' && pool) {
      try {
        const conditions = [];
        const queryParams = [];
        if (cleanEmail) { conditions.push('LOWER(TRIM(email)) = ?'); queryParams.push(cleanEmail); }
        if (cleanMobile) { conditions.push('UPPER(TRIM(mobileNumber)) = ?'); queryParams.push(cleanMobile); }
        if (cleanVehicle) { conditions.push('UPPER(TRIM(vehicleNumber)) = ?'); queryParams.push(cleanVehicle); }
        if (cleanChassis) { conditions.push('UPPER(TRIM(chassisNumber)) = ?'); queryParams.push(cleanChassis); }

        let existingId = null;
        if (conditions.length > 0) {
          const [existing] = await pool.query(
            `SELECT id, evID FROM users WHERE ${conditions.join(' OR ')} LIMIT 1`,
            queryParams
          );
          if (existing && existing.length > 0) {
            existingId = existing[0].id;
          }
        }

        if (existingId) {
          await pool.query(
            'UPDATE users SET fullName=?, chassisNumber=?, vehicleNumber=?, email=?, mobileNumber=? WHERE id=?',
            [cleanFullName, cleanChassis, cleanVehicle, cleanEmail, cleanMobile, existingId]
          );
          const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [existingId]);
          user = rows[0];
        } else {
          const evID = generateEVID(cleanVehicle, cleanChassis, cleanFullName).toUpperCase();
          const [result] = await pool.query(
            'INSERT INTO users (evID, fullName, chassisNumber, vehicleNumber, email, password, mobileNumber) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [evID, cleanFullName, cleanChassis, cleanVehicle, cleanEmail, '', cleanMobile]
          );
          const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
          user = rows[0];
        }
      } catch (mysqlErr) {
        console.warn('MySQL storage error during registration:', mysqlErr.message);
      }
    }

    // 2. Always sync to data/users.json backup file
    try {
      const usersJson = await readUsersFile();
      const existingIdx = usersJson.findIndex(u =>
        (cleanEmail && u.email && u.email.toString().trim().toLowerCase() === cleanEmail) ||
        (cleanMobile && u.mobileNumber && u.mobileNumber.toString().trim().toUpperCase() === cleanMobile) ||
        (cleanVehicle && u.vehicleNumber && u.vehicleNumber.toString().trim().toUpperCase() === cleanVehicle) ||
        (cleanChassis && u.chassisNumber && u.chassisNumber.toString().trim().toUpperCase() === cleanChassis)
      );

      if (existingIdx !== -1) {
        usersJson[existingIdx] = {
          ...usersJson[existingIdx],
          fullName: cleanFullName || usersJson[existingIdx].fullName,
          chassisNumber: cleanChassis || usersJson[existingIdx].chassisNumber,
          vehicleNumber: cleanVehicle || usersJson[existingIdx].vehicleNumber,
          email: cleanEmail || usersJson[existingIdx].email,
          mobileNumber: cleanMobile || usersJson[existingIdx].mobileNumber,
          updatedAt: new Date().toISOString()
        };
        if (!user) user = usersJson[existingIdx];
      } else {
        const evID = user?.evID || generateEVID(cleanVehicle, cleanChassis, cleanFullName).toUpperCase();
        const newUserObj = {
          id: user?.id || Date.now(),
          evID,
          fullName: cleanFullName,
          chassisNumber: cleanChassis,
          vehicleNumber: cleanVehicle,
          email: cleanEmail,
          mobileNumber: cleanMobile,
          registeredAt: new Date().toISOString()
        };
        usersJson.push(newUserObj);
        if (!user) user = newUserObj;
      }
      await writeUsersFile(usersJson);
    } catch (jsonErr) {
      console.warn('File storage error during registration:', jsonErr.message);
    }

    if (!user) {
      const evID = generateEVID(cleanVehicle, cleanChassis, cleanFullName).toUpperCase();
      user = { id: Date.now(), evID, fullName: cleanFullName, chassisNumber: cleanChassis, vehicleNumber: cleanVehicle, email: cleanEmail, mobileNumber: cleanMobile };
    }

    const token = signToken({ evID: user.evID, id: user.id });
    return res.json({ user, token, message: 'Saved successfully to database' });
  } catch (e) {
    console.error('Register error', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, evID } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });
  if (!evID) return res.status(400).json({ error: 'evID is required' });

  try {
    if (storageMode === 'mysql' && pool) {
      const [rows] = await pool.query('SELECT * FROM users WHERE email = ? AND evID = ?', [email, String(evID).trim().toUpperCase()]);
      if (!rows || !rows.length) return res.status(401).json({ error: 'Invalid email or Unique ID' });
      const user = rows[0];
      const token = signToken({ evID: user.evID, id: user.id });
      return res.json({ user, token });
    }

    const users = await readUsersFile();
    const user = users.find((item) => {
      return (item.email || '').toLowerCase() === String(email).trim().toLowerCase()
        && (item.evID || '').toUpperCase() === String(evID).trim().toUpperCase();
    });
    
    if (!user) return res.status(401).json({ error: 'Invalid email or Unique ID' });
    
    const token = signToken({ evID: user.evID, id: user.id });
    return res.json({ user, token });
  } catch (e) {
    console.error('Login error', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/profile', authMiddleware, async (req, res) => {
  try {
    if (storageMode === 'mysql' && pool) {
      const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
      if (!rows || !rows.length) return res.status(404).json({ error: 'User not found' });
      return res.json({ user: rows[0] });
    }
 
    const users = await readUsersFile();
    const user = users.find((item) => String(item.id) === String(req.user.id) || (item.evID || '').toUpperCase() === String(req.user.evID || '').toUpperCase());
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ user });
  } catch (e) {
    console.error('Profile error', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/recharge', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });
  const { evID, amount, method, coins, description } = req.body || {};
  if (!evID || amount === undefined || amount === null) {
    return res.status(400).json({ error: 'evID and amount are required' });
  }

  try {
    const [users] = await pool.query('SELECT id FROM users WHERE evID = ?', [evID]);
    const userId = users && users[0] ? users[0].id : null;
    const [result] = await pool.query(
      'INSERT INTO recharges (evID, userId, amount, method, coins, description) VALUES (?, ?, ?, ?, ?, ?)',
      [evID, userId, parseFloat(amount) || 0.0, method || '', coins ? parseInt(coins, 10) : null, description || null]
    );

    return res.json({ success: true, rechargeId: result.insertId });
  } catch (e) {
    console.error('Recharge save error', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/recharges/:evID', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });
  const { evID } = req.params;
  if (!evID) return res.status(400).json({ error: 'Missing evID' });

  try {
    const [rows] = await pool.query('SELECT * FROM recharges WHERE evID = ? ORDER BY createdAt DESC', [evID]);
    return res.json({ count: rows.length, recharges: rows });
  } catch (e) {
    console.error('Fetch recharges error', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// View all registered users in database
app.get('/api/users', async (req, res) => {
  try {
    if (storageMode === 'mysql' && pool) {
      const [users] = await pool.query('SELECT id, evID, fullName, vehicleNumber, chassisNumber, email, mobileNumber, registeredAt FROM users ORDER BY id DESC');
      return res.json({ storageMode: 'mysql', total: users.length, users });
    }
    const users = await readUsersFile();
    return res.json({ storageMode: 'file', total: users.length, users });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ============================================
// HARDWARE IoT STATION APIs (ESP32 calls these)
// ============================================

// ESP32 sends evID → server checks if valid user → returns user data
app.post('/api/station/verify', async (req, res) => {
  const { evID } = req.body || {};
  if (!evID) return res.status(400).json({ verified: false, error: 'evID is required' });

  const cleanID = String(evID).trim().toUpperCase();

  try {
    if (storageMode === 'mysql' && pool) {
      const [rows] = await pool.query('SELECT id, evID, fullName, vehicleNumber, email FROM users WHERE UPPER(TRIM(evID)) = ?', [cleanID]);
      if (rows && rows.length > 0) {
        const user = rows[0];
        // Check if there's already an active session
        const [active] = await pool.query('SELECT id FROM charging_sessions WHERE evID = ? AND status = "active"', [cleanID]);
        return res.json({
          verified: true,
          user: { id: user.id, evID: user.evID, fullName: user.fullName, vehicleNumber: user.vehicleNumber },
          hasActiveSession: active && active.length > 0
        });
      }
      return res.json({ verified: false, error: 'User not found' });
    }

    // JSON file fallback
    const users = await readUsersFile();
    const user = users.find(u => (u.evID || '').toUpperCase() === cleanID);
    if (user) {
      return res.json({
        verified: true,
        user: { id: user.id, evID: user.evID, fullName: user.fullName, vehicleNumber: user.vehicleNumber },
        hasActiveSession: false
      });
    }
    return res.json({ verified: false, error: 'User not found' });
  } catch (e) {
    console.error('Station verify error:', e);
    return res.status(500).json({ verified: false, error: 'Server error' });
  }
});

// ESP32 starts a new charging session
app.post('/api/station/start', async (req, res) => {
  const { evID, stationId } = req.body || {};
  if (!evID) return res.status(400).json({ error: 'evID is required' });

  const cleanID = String(evID).trim().toUpperCase();
  const station = stationId || 'STATION-01';

  try {
    if (storageMode === 'mysql' && pool) {
      // Get user ID
      const [users] = await pool.query('SELECT id FROM users WHERE UPPER(TRIM(evID)) = ?', [cleanID]);
      const userId = users && users[0] ? users[0].id : null;

      // Cancel any existing active sessions for this user
      await pool.query('UPDATE charging_sessions SET status = "cancelled", endTime = NOW() WHERE evID = ? AND status = "active"', [cleanID]);

      // Start new session
      const [result] = await pool.query(
        'INSERT INTO charging_sessions (evID, userId, stationId, status, startTime) VALUES (?, ?, ?, "active", NOW())',
        [cleanID, userId, station]
      );

      return res.json({ success: true, sessionId: result.insertId, message: 'Charging session started' });
    }

    return res.json({ success: true, sessionId: Date.now(), message: 'Charging session started (file mode)' });
  } catch (e) {
    console.error('Station start error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ESP32 sends real-time charging data every few seconds
app.post('/api/station/status', async (req, res) => {
  const { evID, sessionId, currentAmps, voltage, totalKWh, duration } = req.body || {};
  if (!evID) return res.status(400).json({ error: 'evID is required' });

  try {
    if (storageMode === 'mysql' && pool) {
      const costPerKWh = 12; // ₹12 per kWh — change as needed
      const cost = parseFloat(totalKWh || 0) * costPerKWh;

      if (sessionId) {
        await pool.query(
          'UPDATE charging_sessions SET currentAmps = ?, voltage = ?, totalKWh = ?, cost = ?, duration = ? WHERE id = ? AND status = "active"',
          [parseFloat(currentAmps) || 0, parseFloat(voltage) || 230, parseFloat(totalKWh) || 0, cost, parseInt(duration) || 0, sessionId]
        );
      } else {
        await pool.query(
          'UPDATE charging_sessions SET currentAmps = ?, voltage = ?, totalKWh = ?, cost = ?, duration = ? WHERE evID = ? AND status = "active" ORDER BY id DESC LIMIT 1',
          [parseFloat(currentAmps) || 0, parseFloat(voltage) || 230, parseFloat(totalKWh) || 0, cost, parseInt(duration) || 0, String(evID).trim().toUpperCase()]
        );
      }

      return res.json({ success: true });
    }

    return res.json({ success: true });
  } catch (e) {
    console.error('Station status error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ESP32 completes/stops a charging session
app.post('/api/station/complete', async (req, res) => {
  const { evID, sessionId, totalKWh, duration } = req.body || {};
  if (!evID) return res.status(400).json({ error: 'evID is required' });

  const costPerKWh = 12; // ₹12 per kWh
  const cost = parseFloat(totalKWh || 0) * costPerKWh;

  try {
    if (storageMode === 'mysql' && pool) {
      const cleanID = String(evID).trim().toUpperCase();

      if (sessionId) {
        await pool.query(
          'UPDATE charging_sessions SET status = "completed", endTime = NOW(), totalKWh = ?, cost = ?, duration = ? WHERE id = ?',
          [parseFloat(totalKWh) || 0, cost, parseInt(duration) || 0, sessionId]
        );
      } else {
        await pool.query(
          'UPDATE charging_sessions SET status = "completed", endTime = NOW(), totalKWh = ?, cost = ?, duration = ? WHERE evID = ? AND status = "active" ORDER BY id DESC LIMIT 1',
          [parseFloat(totalKWh) || 0, cost, parseInt(duration) || 0, cleanID]
        );
      }

      return res.json({ success: true, totalKWh: parseFloat(totalKWh) || 0, cost, message: 'Session completed' });
    }

    return res.json({ success: true, totalKWh: parseFloat(totalKWh) || 0, cost, message: 'Session completed (file mode)' });
  } catch (e) {
    console.error('Station complete error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Website fetches charging session history for a user
app.get('/api/station/sessions/:evID', async (req, res) => {
  const { evID } = req.params;
  if (!evID) return res.status(400).json({ error: 'evID is required' });

  try {
    if (storageMode === 'mysql' && pool) {
      const [rows] = await pool.query(
        'SELECT * FROM charging_sessions WHERE evID = ? ORDER BY startTime DESC LIMIT 50',
        [String(evID).trim().toUpperCase()]
      );
      return res.json({ count: rows.length, sessions: rows });
    }

    return res.json({ count: 0, sessions: [] });
  } catch (e) {
    console.error('Fetch sessions error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Get currently active charging session (for website live view)
app.get('/api/station/active', async (req, res) => {
  try {
    if (storageMode === 'mysql' && pool) {
      const [rows] = await pool.query(
        `SELECT cs.*, u.fullName, u.vehicleNumber FROM charging_sessions cs
         LEFT JOIN users u ON cs.userId = u.id
         WHERE cs.status = 'active' ORDER BY cs.startTime DESC`
      );
      return res.json({ count: rows.length, sessions: rows });
    }
    return res.json({ count: 0, sessions: [] });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
});

async function startServer() {
  try {
    await initDB();
    console.log(`Server listening on port ${PORT}`);
    app.listen(PORT);
  } catch (e) {
    console.error('Failed to initialize DB', e);
    process.exit(1);
  }
}

startServer();
