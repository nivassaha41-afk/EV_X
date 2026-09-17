require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { exec } = require('child_process');

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

async function tryAutoStartMySQL() {
  if (process.platform === 'win32') {
    const xamppMysql = 'C:\\xampp\\mysql\\bin\\mysqld.exe';
    if (fs.existsSync(xamppMysql)) {
      console.log('[MySQL] Attempting to auto-start XAMPP MySQL daemon...');
      try {
        exec('Start-Process -FilePath "C:\\xampp\\mysql\\bin\\mysqld.exe" -ArgumentList "--standalone" -WindowStyle Hidden', { shell: 'powershell.exe' });
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } catch (e) {
        console.warn('[MySQL] Auto-start attempt error:', e.message);
      }
    }
  }
}

async function syncJsonUsersToMySQL() {
  if (!pool || storageMode !== 'mysql') return;
  try {
    const jsonUsers = await readUsersFile();
    if (!jsonUsers || !jsonUsers.length) return;

    let migrated = 0;
    for (const u of jsonUsers) {
      if (!u || (!u.evID && !u.email && !u.mobileNumber)) continue;

      const searchEvID = (u.evID || '').trim();
      const searchEmail = (u.email || '').trim().toLowerCase();
      const searchMobile = (u.mobileNumber || '').trim();
      const searchVehicle = (u.vehicleNumber || '').trim();
      const searchChassis = (u.chassisNumber || '').trim();

      const [existing] = await pool.query(
        'SELECT id FROM users WHERE (evID = ? AND evID != "") OR (email = ? AND email != "") OR (mobileNumber = ? AND mobileNumber != "") OR (vehicleNumber = ? AND vehicleNumber != "") OR (chassisNumber = ? AND chassisNumber != "")',
        [searchEvID, searchEmail, searchMobile, searchVehicle, searchChassis]
      );

      if (!existing || !existing.length) {
        const evIDToUse = searchEvID || generateEVID(searchVehicle, searchChassis, u.fullName || '').toUpperCase();
        let formattedDate = new Date().toISOString().slice(0, 19).replace('T', ' ');
        if (u.registeredAt) {
          const d = new Date(u.registeredAt);
          if (!isNaN(d.getTime())) {
            formattedDate = d.toISOString().slice(0, 19).replace('T', ' ');
          }
        }

        await pool.query(
          'INSERT INTO users (evID, fullName, chassisNumber, vehicleNumber, email, password, mobileNumber, registeredAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            evIDToUse,
            u.fullName || '',
            u.chassisNumber || '',
            u.vehicleNumber || '',
            u.email || '',
            u.password || '',
            u.mobileNumber || '',
            formattedDate
          ]
        );
        migrated++;
      }
    }
    if (migrated > 0) {
      console.log(`[MySQL Sync] Successfully migrated ${migrated} user(s) from users.json into MySQL database evcharge_db!`);
    }
  } catch (err) {
    console.warn('[MySQL Sync Warning]', err.message);
  }
}

async function connectToMySQLHost(hostToTry) {
  const tempPool = mysql.createPool({
    host: hostToTry,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASS,
    waitForConnections: true,
    connectionLimit: 10,
    connectTimeout: 4000,
    queueLimit: 0
  });

  const conn = await tempPool.getConnection();
  try {
    const escapedDbName = String(DB_NAME).replace(/`/g, '``');
    const createDbSql = `CREATE DATABASE IF NOT EXISTS \`${escapedDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`;
    await conn.query(createDbSql);
  } finally {
    conn.release();
  }
  await tempPool.end().catch(() => {});

  const finalPool = mysql.createPool({
    host: hostToTry,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    connectTimeout: 4000,
    queueLimit: 0
  });

  return finalPool;
}

async function initDB() {
  const hostsToTry = [DB_HOST, '127.0.0.1', 'localhost'].filter((v, i, a) => a.indexOf(v) === i);
  let connected = false;

  for (const host of hostsToTry) {
    try {
      pool = await connectToMySQLHost(host);
      connected = true;
      break;
    } catch (e) {
      // Retry next
    }
  }

  if (!connected) {
    await tryAutoStartMySQL();
    for (const host of hostsToTry) {
      try {
        pool = await connectToMySQLHost(host);
        connected = true;
        break;
      } catch (e) {
        // Retry next
      }
    }
  }

  if (connected && pool) {
    try {
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

      storageMode = 'mysql';
      console.log('✅ MySQL Connected successfully! Using MySQL database "evcharge_db" for user storage');

      await syncJsonUsersToMySQL();
      return;
    } catch (dbErr) {
      console.error('MySQL table initialization error:', dbErr.message);
    }
  }

  storageMode = 'file';
  pool = null;
  console.warn('⚠️ MySQL unavailable, using local JSON storage (users.json) instead');
  ensureDataFile();
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
  if (!mobileNumber) return res.status(400).json({ error: 'mobileNumber is required' });
  if (!email) return res.status(400).json({ error: 'email is required' });

  const evID = generateEVID(vehicleNumber || '', chassisNumber || '', fullName || '').toUpperCase();

  try {
    if (storageMode === 'mysql' && pool) {
      const [existing] = await pool.query(
        'SELECT email, mobileNumber, vehicleNumber, chassisNumber FROM users WHERE email = ? OR mobileNumber = ? OR vehicleNumber = ? OR chassisNumber = ?',
        [email, mobileNumber, vehicleNumber, chassisNumber]
      );

      if (existing && existing.length) {
        const duplicateFields = [];
        const record = existing[0];
        if (record.email && record.email.trim().toLowerCase() === String(email).trim().toLowerCase()) duplicateFields.push('email');
        if (record.mobileNumber && record.mobileNumber.trim().toUpperCase() === String(mobileNumber).trim().toUpperCase()) duplicateFields.push('mobile number');
        if (record.vehicleNumber && record.vehicleNumber.trim().toUpperCase() === String(vehicleNumber).trim().toUpperCase()) duplicateFields.push('vehicle number');
        if (record.chassisNumber && record.chassisNumber.trim().toUpperCase() === String(chassisNumber).trim().toUpperCase()) duplicateFields.push('chassis number');
        return res.status(400).json({ error: `Already registered: ${duplicateFields.join(', ') || 'one of the provided details'}` });
      }

      const [result] = await pool.query(
        'INSERT INTO users (evID, fullName, chassisNumber, vehicleNumber, email, password, mobileNumber) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [evID, fullName || '', chassisNumber || '', vehicleNumber || '', email, '', mobileNumber]
      );

      const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
      const user = rows[0];

      // Keep users.json in sync as secondary backup
      try {
        const users = await readUsersFile();
        if (!users.some((u) => u.evID === user.evID)) {
          users.push(user);
          await writeUsersFile(users);
        }
      } catch (err) {}

      const token = signToken({ evID: user.evID, id: user.id });
      console.log(`[Register] New user registered & saved in MySQL DB: ${user.fullName} (${user.evID})`);
      return res.json({ user, token, storageMode: 'mysql' });
    }

    const users = await readUsersFile();
    const existing = users.find((user) => {
      const sameEmail = (user.email || '').toString().trim().toLowerCase() === String(email).trim().toLowerCase();
      const sameMobile = (user.mobileNumber || '').toString().trim().toUpperCase() === String(mobileNumber).trim().toUpperCase();
      const sameVehicle = (user.vehicleNumber || '').toString().trim().toUpperCase() === String(vehicleNumber).trim().toUpperCase();
      const sameChassis = (user.chassisNumber || '').toString().trim().toUpperCase() === String(chassisNumber).trim().toUpperCase();
      return sameEmail || sameMobile || sameVehicle || sameChassis;
    });

    if (existing) {
      const duplicateFields = [];
      if ((existing.email || '').trim().toLowerCase() === String(email).trim().toLowerCase()) duplicateFields.push('email');
      if ((existing.mobileNumber || '').trim().toUpperCase() === String(mobileNumber).trim().toUpperCase()) duplicateFields.push('mobile number');
      if ((existing.vehicleNumber || '').trim().toUpperCase() === String(vehicleNumber).trim().toUpperCase()) duplicateFields.push('vehicle number');
      if ((existing.chassisNumber || '').trim().toUpperCase() === String(chassisNumber).trim().toUpperCase()) duplicateFields.push('chassis number');
      return res.status(400).json({ error: `Already registered: ${duplicateFields.join(', ') || 'one of the provided details'}` });
    }

    const user = {
      id: Date.now(),
      evID,
      fullName: fullName || '',
      chassisNumber: chassisNumber || '',
      vehicleNumber: vehicleNumber || '',
      email: String(email || '').trim(),
      mobileNumber,
      registeredAt: new Date().toISOString()
    };

    users.push(user);
    await writeUsersFile(users);
    const token = signToken({ evID: user.evID, id: user.id });
    console.log(`[Register] User registered & saved in local JSON file: ${user.fullName} (${user.evID})`);
    return res.json({ user, token, storageMode: 'file' });
  } catch (e) {
    console.error('Register error', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, evID } = req.body || {};
  if (!email && !evID) return res.status(400).json({ error: 'Email or Authentication ID is required' });

  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanEvID = evID ? String(evID).trim().toUpperCase() : '';

  try {
    if (storageMode === 'mysql' && pool) {
      let query = 'SELECT * FROM users WHERE email = ? AND evID = ?';
      let queryParams = [cleanEmail, cleanEvID];

      if (!cleanEmail) {
        query = 'SELECT * FROM users WHERE evID = ?';
        queryParams = [cleanEvID];
      } else if (!cleanEvID) {
        query = 'SELECT * FROM users WHERE email = ?';
        queryParams = [cleanEmail];
      }

      const [rows] = await pool.query(query, queryParams);
      if (!rows || !rows.length) {
        return res.status(401).json({ error: 'Account not found. Please register first on the Sign Up page.' });
      }

      const user = rows[0];
      const token = signToken({ evID: user.evID, id: user.id });
      return res.json({ user, token });
    }

    const users = await readUsersFile();
    const user = users.find((item) => {
      const sameEmail = cleanEmail && (item.email || '').toLowerCase() === cleanEmail;
      const sameEvID = cleanEvID && (item.evID || '').toUpperCase() === cleanEvID;
      return (cleanEmail && cleanEvID) ? (sameEmail || sameEvID) : (sameEmail || sameEvID);
    });

    if (!user) {
      return res.status(401).json({ error: 'Account not found. Please register first on the Sign Up page.' });
    }

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
