import { supabase } from '../config/supabase.js'
import jwt from 'jsonwebtoken'

// Verifies the JWT token on every protected request.
// Attaches { id, school_id, role, name } to req.user
export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' })
  }

  const token = authHeader.split(' ')[1]

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    req.user = payload
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

// Role guard — call after authenticate()
// Usage: authorize('admin')  or  authorize('admin', 'principal')
export function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Access denied' })
    }
    next()
  }
}

// Checks if the school's trial or subscription is still active
export async function checkSubscription(req, res, next) {
  try {
    const { data: school } = await supabase
      .from('schools')
      .select('status, trial_ends_at, name')
      .eq('id', req.user.school_id)
      .single()

    if (!school) return res.status(404).json({ error: 'School not found' })

    // Active paid subscription — always allow
    if (school.status === 'active') return next()

    // Suspended by admin
    if (school.status === 'suspended') {
      return res.status(403).json({ 
        error: 'suspended',
        message: 'Your account has been suspended. Please contact support.'
      })
    }

    // Check trial expiry
    if (school.trial_ends_at && new Date() > new Date(school.trial_ends_at)) {
      // Auto-update status to expired
      await supabase
        .from('schools')
        .update({ status: 'expired' })
        .eq('id', req.user.school_id)

      return res.status(403).json({ 
        error: 'trial_expired',
        message: 'Your 14-day free trial has ended.',
        trial_ends_at: school.trial_ends_at
      })
    }

    next()
  } catch (err) {
    next()
  }
}
