import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import routes from './routes/index.js'

const app = express()

// ✅ FIX: Tell Express to trust Railway's proxy (fixes rate-limit crash)
app.set('trust proxy', 1)
const PORT = process.env.PORT || 4000

// ── Security headers ──────────────────────────────────
app.use(helmet())

// ── CORS — allow only the frontend origin ─────────────
app.use(cors({
  origin: [
    'https://attendease.com.ng',
    'https://www.attendease.com.ng',
    'https://app.attendease.com.ng',
    'https://attendance-frontend-gamma.vercel.app',
    'http://localhost:5173',
  ],
  credentials: true,
}))

// ── Body parser ───────────────────────────────────────
app.use(express.json({ limit: '15mb' })) // 15mb for base64 photo uploads

// ── Rate limiting ─────────────────────────────────────
// Auth routes: 20 requests per 15 minutes (prevents brute force)
app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, please try again later' },
}))

// Check-in route: 200 per minute (busy school gate)
app.use('/api/attendance/checkin', rateLimit({
  windowMs: 60 * 1000,
  max: 200,
}))

// ── API routes ────────────────────────────────────────
app.use('/api', routes)

// ── Health check ──────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }))

// ── 404 handler ───────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` })
})

// ── Global error handler ──────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────┐
  │  School Attendance API running           │
  │  http://localhost:${PORT}                   │
  │  Environment: ${process.env.NODE_ENV || 'development'}             │
  └─────────────────────────────────────────┘
  `)
})
