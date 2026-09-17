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

  if (!cleanMobile) return res.status(400).json({ error: 'Mobile number is required' });
  if (!cleanEmail) return res.status(400).json({ error: 'Email address is required' });

  const evID = generateEVID(cleanVehicle, cleanChassis, cleanFullName).toUpperCase();

  try {
    if (storageMode === 'mysql' && pool) {
      const conditions = [];
      const queryParams = [];

      if (cleanEmail) {
        conditions.push('LOWER(TRIM(email)) = ?');
        queryParams.push(cleanEmail);
      }
      if (cleanMobile) {
        conditions.push('UPPER(TRIM(mobileNumber)) = ?');
        queryParams.push(cleanMobile);
      }
      if (cleanVehicle) {
        conditions.push('UPPER(TRIM(vehicleNumber)) = ?');
        queryParams.push(cleanVehicle);
      }
      if (cleanChassis) {
        conditions.push('UPPER(TRIM(chassisNumber)) = ?');
        queryParams.push(cleanChassis);
      }

      if (conditions.length > 0) {
        const [existing] = await pool.query(
          `SELECT email, mobileNumber, vehicleNumber, chassisNumber FROM users WHERE ${conditions.join(' OR ')}`,
          queryParams
        );

        if (existing && existing.length) {
          const duplicateFields = new Set();
          for (const record of existing) {
            if (cleanEmail && record.email && record.email.toString().trim().toLowerCase() === cleanEmail) duplicateFields.add('email');
            if (cleanMobile && record.mobileNumber && record.mobileNumber.toString().trim().toUpperCase() === cleanMobile) duplicateFields.add('mobile number');
            if (cleanVehicle && record.vehicleNumber && record.vehicleNumber.toString().trim().toUpperCase() === cleanVehicle) duplicateFields.add('vehicle number');
            if (cleanChassis && record.chassisNumber && record.chassisNumber.toString().trim().toUpperCase() === cleanChassis) duplicateFields.add('chassis number');
          }
          if (duplicateFields.size > 0) {
            return res.status(400).json({ error: `Already registered: ${Array.from(duplicateFields).join(', ')}` });
          }
        }
      }

      const [result] = await pool.query(
        'INSERT INTO users (evID, fullName, chassisNumber, vehicleNumber, email, password, mobileNumber) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [evID, cleanFullName, cleanChassis, cleanVehicle, cleanEmail, '', cleanMobile]
      );

      const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
      const user = rows[0];

      // Keep users.json synchronized as backup
      try {
        const usersJson = await readUsersFile();
        if (!usersJson.some((u) => u.evID === user.evID || u.email === user.email)) {
          usersJson.push({
            id: user.id,
            evID: user.evID,
            fullName: user.fullName,
            chassisNumber: user.chassisNumber,
            vehicleNumber: user.vehicleNumber,
            email: user.email,
            mobileNumber: user.mobileNumber,
            registeredAt: user.registeredAt || new Date().toISOString()
          });
          await writeUsersFile(usersJson);
        }
      } catch (err) {
        console.warn('Failed to sync to users.json:', err.message);
      }

      const token = signToken({ evID: user.evID, id: user.id });
      return res.json({ user, token });
    }

    const users = await readUsersFile();

    const existing = users.find((user) => {
      const sameEmail = cleanEmail && user.email && user.email.toString().trim().toLowerCase() === cleanEmail;
      const sameMobile = cleanMobile && user.mobileNumber && user.mobileNumber.toString().trim().toUpperCase() === cleanMobile;
      const sameVehicle = cleanVehicle && user.vehicleNumber && user.vehicleNumber.toString().trim().toUpperCase() === cleanVehicle;
      const sameChassis = cleanChassis && user.chassisNumber && user.chassisNumber.toString().trim().toUpperCase() === cleanChassis;
      return sameEmail || sameMobile || sameVehicle || sameChassis;
    });

    if (existing) {
      const duplicateFields = [];
      if (cleanEmail && existing.email && existing.email.toString().trim().toLowerCase() === cleanEmail) duplicateFields.push('email');
      if (cleanMobile && existing.mobileNumber && existing.mobileNumber.toString().trim().toUpperCase() === cleanMobile) duplicateFields.push('mobile number');
      if (cleanVehicle && existing.vehicleNumber && existing.vehicleNumber.toString().trim().toUpperCase() === cleanVehicle) duplicateFields.push('vehicle number');
      if (cleanChassis && existing.chassisNumber && existing.chassisNumber.toString().trim().toUpperCase() === cleanChassis) duplicateFields.push('chassis number');
      return res.status(400).json({ error: `Already registered: ${duplicateFields.join(', ') || 'one of the provided details'}` });
    }

    const user = {
      id: Date.now(),
      evID,
      fullName: cleanFullName,
      chassisNumber: cleanChassis,
      vehicleNumber: cleanVehicle,
      email: cleanEmail,
      mobileNumber: cleanMobile,
      registeredAt: new Date().toISOString()
    };

    users.push(user);
    await writeUsersFile(users);
    const token = signToken({ evID: user.evID, id: user.id });
    return res.json({ user, token });
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
