// ============================================
// WHATSAPP SESSION GENERATOR - DARKFORGE-X EDITION
// Advanced WhatsApp Web Session Management
// ============================================

const express = require('express');
const { create } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const NodeCache = require('node-cache');
const { v4: uuidv4 } = require('uuid');
const qrcode = require('qrcode-terminal');
const expressWs = require('express-ws');

// Initialize Express with WebSocket support
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// WebSocket endpoint
expressWs(app);

// Cache for storing sessions and pairing codes
const sessionCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
const pairingCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Store active connections
const activeConnections = new Map();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'online', timestamp: new Date().toISOString() });
});

// ============================================
// WHATSAPP CLIENT MANAGER CLASS
// ============================================

class WhatsAppClientManager {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.client = null;
    this.qrCode = null;
    this.isConnected = false;
    this.pairingCode = null;
    this.sessionData = null;
    this.connectionAttempts = 0;
    this.maxRetries = 3;
    this.phoneNumber = null;
  }

  // Generate pairing code
  async generatePairingCode(phoneNumber) {
    try {
      this.phoneNumber = phoneNumber;
      const pairingCode = Math.floor(100000 + Math.random() * 900000).toString();
      
      // Store in cache
      pairingCache.set(pairingCode, {
        sessionId: this.sessionId,
        phoneNumber: phoneNumber,
        timestamp: Date.now()
      });

      this.pairingCode = pairingCode;
      
      // Return code for display
      return {
        success: true,
        pairingCode: pairingCode,
        sessionId: this.sessionId,
        instructions: [
          "1. Buka WhatsApp di ponsel Anda",
          "2. Ketuk Menu (tiga titik) → Linked Devices",
          `3. Ketuk 'Link a Device' dan masukkan kode: ${pairingCode}`,
          "4. Tunggu hingga terkoneksi (maks 5 menit)"
        ]
      };
    } catch (error) {
      console.error('Error generating pairing code:', error);
      return { success: false, error: error.message };
    }
  }

  // Initialize WhatsApp client with pairing code
  async initializeWithPairingCode(pairingCode) {
    try {
      const pairingData = pairingCache.get(pairingCode);
      if (!pairingData) {
        throw new Error('Pairing code tidak valid atau telah kedaluwarsa');
      }

      this.phoneNumber = pairingData.phoneNumber;
      
      // Create WhatsApp client with Baileys
      const logger = pino({ level: 'silent' });
      
      this.client = create({
        logger,
        printQRInTerminal: false,
        auth: {
          creds: {
            noiseKey: {},
            signedIdentityKey: {},
            signedPreKey: {},
            registrationId: 0,
            advSecretKey: ''
          },
          keys: {}
        },
        browser: ['WhatsApp Session Generator', 'Chrome', '3.0'],
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        getMessage: async () => ({})
      });

      // Setup event handlers
      this.setupEventHandlers();

      // Start authentication with pairing code
      await this.client.start({
        phoneNumber: this.phoneNumber,
        pairingCode: pairingCode
      });

      return { success: true, message: 'Client initialized with pairing code' };
    } catch (error) {
      console.error('Error initializing client:', error);
      return { success: false, error: error.message };
    }
  }

  // Setup WhatsApp client event handlers
  setupEventHandlers() {
    if (!this.client) return;

    // QR Code handler
    this.client.ev.on('qr', (qr) => {
      this.qrCode = qr;
      qrcode.generate(qr, { small: true });
      
      // Emit to WebSocket
      io.to(this.sessionId).emit('qr_update', { qr: qr });
    });

    // Connection update handler
    this.client.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== 401;
        
        if (shouldReconnect && this.connectionAttempts < this.maxRetries) {
          this.connectionAttempts++;
          setTimeout(() => {
            this.client?.connect();
          }, 3000);
        } else {
          this.isConnected = false;
          io.to(this.sessionId).emit('connection_status', { 
            status: 'disconnected',
            reason: 'Connection closed'
          });
        }
      } else if (connection === 'open') {
        this.isConnected = true;
        this.connectionAttempts = 0;
        io.to(this.sessionId).emit('connection_status', { 
          status: 'connected',
          phoneNumber: this.phoneNumber
        });
        
        // Save session data
        this.saveSessionData();
      }
    });

    // Credentials update handler
    this.client.ev.on('creds.update', () => {
      this.saveSessionData();
    });

    // Messages handler
    this.client.ev.on('messages.upsert', (m) => {
      console.log('New message received:', m);
    });
  }

  // Save session data
  async saveSessionData() {
    try {
      if (!this.client || !this.client.authState) return;

      const sessionData = {
        sessionId: this.sessionId,
        phoneNumber: this.phoneNumber,
        credentials: this.client.authState.creds,
        keys: this.client.authState.keys,
        timestamp: new Date().toISOString(),
        platform: 'whatsapp-web'
      };

      this.sessionData = sessionData;
      
      // Save to cache
      sessionCache.set(this.sessionId, sessionData);
      
      // Save to file (optional)
      const sessionDir = path.join(__dirname, 'sessions');
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }
      
      const sessionFile = path.join(sessionDir, `${this.sessionId}.json`);
      fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
      
      // Emit session ready event
      io.to(this.sessionId).emit('session_ready', {
        sessionId: this.sessionId,
        downloadUrl: `/api/download/${this.sessionId}`
      });
      
      return sessionData;
    } catch (error) {
      console.error('Error saving session:', error);
      return null;
    }
  }

  // Get session data
  getSessionData() {
    return this.sessionData;
  }

  // Cleanup
  async cleanup() {
    try {
      if (this.client) {
        await this.client.logout();
        await this.client.end();
      }
      
      // Remove from cache
      sessionCache.del(this.sessionId);
      activeConnections.delete(this.sessionId);
      
      // Clean up pairing code
      if (this.pairingCode) {
        pairingCache.del(this.pairingCode);
      }
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }
}

// ============================================
// API ENDPOINTS
// ============================================

// Start new session
app.post('/api/session/start', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({ 
        success: false, 
        error: 'Nomor telepon diperlukan' 
      });
    }

    // Validate phone number format
    const phoneRegex = /^[0-9]{10,15}$/;
    if (!phoneRegex.test(phoneNumber.replace(/[+\s]/g, ''))) {
      return res.status(400).json({ 
        success: false, 
        error: 'Format nomor telepon tidak valid' 
      });
    }

    // Generate unique session ID
    const sessionId = `wa_session_${uuidv4().replace(/-/g, '')}`;
    
    // Create client manager
    const clientManager = new WhatsAppClientManager(sessionId);
    activeConnections.set(sessionId, clientManager);
    
    // Generate pairing code
    const result = await clientManager.generatePairingCode(phoneNumber);
    
    if (!result.success) {
      activeConnections.delete(sessionId);
      return res.status(500).json(result);
    }

    res.json({
      success: true,
      sessionId: sessionId,
      pairingCode: result.pairingCode,
      instructions: result.instructions,
      sessionUrl: `/session/${sessionId}`
    });

  } catch (error) {
    console.error('Error starting session:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Verify pairing code
app.post('/api/session/verify', async (req, res) => {
  try {
    const { pairingCode, sessionId } = req.body;
    
    if (!pairingCode || !sessionId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Pairing code dan session ID diperlukan' 
      });
    }

    const clientManager = activeConnections.get(sessionId);
    if (!clientManager) {
      return res.status(404).json({ 
        success: false, 
        error: 'Session tidak ditemukan' 
      });
    }

    // Initialize client with pairing code
    const result = await clientManager.initializeWithPairingCode(pairingCode);
    
    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json({
      success: true,
      message: 'Pairing code berhasil diverifikasi',
      sessionId: sessionId,
      status: 'initializing'
    });

  } catch (error) {
    console.error('Error verifying pairing code:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get session status
app.get('/api/session/:sessionId/status', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const clientManager = activeConnections.get(sessionId);
    
    if (!clientManager) {
      return res.status(404).json({ 
        success: false, 
        error: 'Session tidak ditemukan' 
      });
    }

    const sessionData = sessionCache.get(sessionId);
    
    res.json({
      success: true,
      sessionId: sessionId,
      isConnected: clientManager.isConnected,
      phoneNumber: clientManager.phoneNumber,
      pairingCode: clientManager.pairingCode,
      hasSessionData: !!sessionData,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error getting session status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Download session data
app.get('/api/download/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionData = sessionCache.get(sessionId);
    
    if (!sessionData) {
      return res.status(404).json({ 
        success: false, 
        error: 'Session data tidak ditemukan' 
      });
    }

    // Set headers for file download
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${sessionId}.json"`);
    
    res.send(JSON.stringify(sessionData, null, 2));

  } catch (error) {
    console.error('Error downloading session:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// WebSocket endpoint for real-time updates
app.ws('/ws/:sessionId', (ws, req) => {
  const { sessionId } = req.params;
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'join_session':
          // Join WebSocket room
          ws.sessionId = sessionId;
          break;
          
        case 'get_status':
          const clientManager = activeConnections.get(sessionId);
          if (clientManager) {
            ws.send(JSON.stringify({
              type: 'status_update',
              data: {
                isConnected: clientManager.isConnected,
                phoneNumber: clientManager.phoneNumber,
                pairingCode: clientManager.pairingCode
              }
            }));
          }
          break;
      }
    } catch (error) {
      console.error('WebSocket error:', error);
    }
  });
  
  ws.on('close', () => {
    console.log(`WebSocket closed for session: ${sessionId}`);
  });
});

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('join_session', (sessionId) => {
    socket.join(sessionId);
    console.log(`Client ${socket.id} joined session: ${sessionId}`);
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Cleanup endpoint (for testing)
app.post('/api/cleanup/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const clientManager = activeConnections.get(sessionId);
    
    if (clientManager) {
      await clientManager.cleanup();
    }
    
    res.json({ 
      success: true, 
      message: 'Session cleaned up successfully' 
    });
    
  } catch (error) {
    console.error('Error during cleanup:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// List active sessions (admin)
app.get('/api/sessions/active', (req, res) => {
  const sessions = Array.from(activeConnections.entries()).map(([id, manager]) => ({
    sessionId: id,
    phoneNumber: manager.phoneNumber,
    isConnected: manager.isConnected,
    pairingCode: manager.pairingCode,
    connectionAttempts: manager.connectionAttempts
  }));
  
  res.json({
    success: true,
    count: sessions.length,
    sessions: sessions
  });
});

// ============================================
// STATIC FILE SERVING
// ============================================

app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// ERROR HANDLING MIDDLEWARE
// ============================================

app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  
  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// ============================================
// SERVER STARTUP
// ============================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`
  ============================================
  WHATSAPP SESSION GENERATOR - DARKFORGE-X
  ============================================
  Server running on port: ${PORT}
  Environment: ${process.env.NODE_ENV || 'development'}
  WebSocket: ws://localhost:${PORT}
  API Base: http://localhost:${PORT}/api
  ============================================
  `);
  
  // Create sessions directory if it doesn't exist
  const sessionsDir = path.join(__dirname, 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
    console.log('Created sessions directory:', sessionsDir);
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  
  // Cleanup all active connections
  for (const [sessionId, clientManager] of activeConnections.entries()) {
    await clientManager.cleanup();
  }
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = app;
