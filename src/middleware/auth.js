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
