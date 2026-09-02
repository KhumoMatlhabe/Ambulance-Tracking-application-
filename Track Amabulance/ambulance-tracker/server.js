const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'emergency_app_super_secret_key_123';

// 1. CRITICAL: Middleware configuration
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================================
// 1. SQLITE DATABASE SETUP
// =========================================================================
const db = new sqlite3.Database('./emergency_fleet.db', (err) => {
  if (err) {
    console.error('❌ Failed to connect to SQLite database:', err.message);
  } else {
    console.log('📦 Connected to SQLite database file: emergency_fleet.db');
  }
});

// Initialize database tables on server start
db.serialize(() => {
  // Table for Emergency Incidents
  db.run(`
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id TEXT UNIQUE,
      patient_name TEXT,
      phone TEXT,
      notes TEXT,
      latitude REAL,
      longitude REAL,
      assigned_unit_id TEXT,
      status TEXT DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Table for User Accounts
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT CHECK(role IN ('PATIENT', 'DRIVER', 'DISPATCHER')) DEFAULT 'PATIENT',
      unit_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Table for Ambulance Telemetry Logs
  db.run(`
    CREATE TABLE IF NOT EXISTS telemetry_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id TEXT,
      latitude REAL,
      longitude REAL,
      status TEXT,
      speed REAL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// =========================================================================
// 2. EXPRESS ROUTES
// =========================================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Fetch past incident history for dashboards
app.get('/api/incidents', (req, res) => {
  db.all('SELECT * FROM incidents ORDER BY created_at DESC LIMIT 50', [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ incidents: rows });
  });
});

// In-memory store for active streaming ambulances
const activeAmbulances = new Map();

// =========================================================================
// 3. WEBSOCKET REAL-TIME EVENTS
// =========================================================================
io.on('connection', (socket) => {
  console.log(`[+] Client connected: ${socket.id}`);

  // Send initial fleet state to connecting client
  socket.emit('initial_fleet_state', Array.from(activeAmbulances.values()));
  socket.emit('available_units', Array.from(activeAmbulances.values()));

  // A. Driver GPS Telemetry Updates
  socket.on('update_location', (data) => {
    const { unitId, lat, lng, status, speed, driverName } = data;

    const payload = {
      unitId: unitId || 'Ambulance-01',
      driverName: driverName || 'Active Driver',
      lat: lat,
      lng: lng,
      status: status || 'AVAILABLE',
      speed: speed || 0,
      updatedAt: new Date().toLocaleTimeString()
    };

    activeAmbulances.set(payload.unitId, payload);

    // Broadcast live telemetry to patients & dispatchers
    io.emit('location_changed', payload);

    // PERSIST TO DATABASE
    const sql = `INSERT INTO telemetry_logs (unit_id, latitude, longitude, status, speed) VALUES (?, ?, ?, ?, ?)`;
    db.run(sql, [payload.unitId, lat, lng, payload.status, payload.speed], (err) => {
      if (err) console.error('❌ Error saving telemetry log:', err.message);
    });
  });

  // B. Emergency SOS Requests from Patients
  socket.on('emergency_request', (data) => {
    const incidentCode = `INC-${Date.now().toString().slice(-4)}`;
    const timestamp = new Date().toLocaleTimeString();

    const incidentData = {
      id: incidentCode,
      incidentId: incidentCode,
      name: data.name || 'Anonymous Patient',
      patientName: data.name || 'Anonymous Patient',
      phone: data.phone || 'Unspecified',
      notes: data.notes || 'None',
      lat: data.lat,
      lng: data.lng,
      timestamp: timestamp
    };

    console.log(`[🚨] EMERGENCY SOS: ${incidentData.patientName} (${incidentData.phone})`);

    // 1. Alert dispatchers and driver dashboards immediately
    io.emit('new_incident_alert', incidentData);
    io.emit('incoming_emergency', incidentData);

    // 2. PERSIST TO DATABASE
    const sql = `
      INSERT INTO incidents (incident_id, patient_name, phone, notes, latitude, longitude, status)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
    `;
    db.run(
      sql,
      [incidentData.incidentId, incidentData.patientName, incidentData.phone, incidentData.notes, data.lat, data.lng],
      function (err) {
        if (err) {
          console.error('❌ Failed to insert incident into SQLite:', err.message);
        } else {
          console.log(`💾 Saved incident ${incidentData.incidentId} to database (Row ID: ${this.lastID})`);
        }
      }
    );
  });

  // C. Driver Accepts Emergency Callout
  socket.on('accept_request', (data) => {
    const { requestId, unitId, driverName } = data;
    console.log(`[✅] Request ${requestId} accepted by ${unitId}`);

    // Update status in SQLite database
    const sql = `UPDATE incidents SET assigned_unit_id = ?, status = 'ACCEPTED' WHERE incident_id = ? OR id = ?`;
    db.run(sql, [unitId, requestId, requestId], (err) => {
      if (err) console.error('❌ Error updating incident assignment:', err.message);
    });

    // Notify patient clients that unit has accepted
    io.emit('request_accepted', {
      requestId: requestId,
      unitId: unitId,
      driverName: driverName || 'Assigned Driver'
    });
  });

  socket.on('disconnect', () => {
    console.log(`[-] Client disconnected: ${socket.id}`);
  });
});

// =========================================================================
// 4. AUTHENTICATION ENDPOINTS
// =========================================================================

// REGISTER ENDPOINT
app.post('/api/auth/register', async (req, res) => {
  try {
    const { fullName, email, password, role, unitId } = req.body;

    if (!fullName || !email || !password) {
      return res.status(400).json({ error: 'Full name, email, and password are required.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userRole = role ? role.toUpperCase() : 'PATIENT';

    const sql = `
      INSERT INTO users (full_name, email, password_hash, role, unit_id)
      VALUES (?, ?, ?, ?, ?)
    `;

    db.run(sql, [fullName, email.toLowerCase(), hashedPassword, userRole, unitId || null], function (err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: 'An account with this email already exists.' });
        }
        return res.status(500).json({ error: err.message });
      }

      const token = jwt.sign(
        { userId: this.lastID, email: email.toLowerCase(), role: userRole, unitId: unitId || null },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      res.status(201).json({
        message: 'User registered successfully',
        token,
        user: { id: this.lastID, fullName, email, role: userRole, unitId: unitId || null }
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error during registration.' });
  }
});

// LOGIN ENDPOINT
app.post('/api/auth/login', function (req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const sql = `SELECT * FROM users WHERE email = ?`;
  db.get(sql, [email.toLowerCase()], async (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) return res.status(401).json({ error: 'Invalid email or password.' });

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, unitId: user.unit_id },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        role: user.role,
        unitId: user.unit_id
      }
    });
  });
});

// Middleware helper to verify JWT tokens
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = decoded;
    next();
  });
}

// =========================================================================
// 5. SERVER LAUNCH
// =========================================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`🚑 Emergency Tracking Server Live at http://localhost:${PORT}`);
  console.log(`==================================================`);
});