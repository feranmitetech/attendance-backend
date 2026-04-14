import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import { z } from 'zod'

const registerSchema = z.object({
  schoolName: z.string().min(3),
  subdomain: z.string().min(3).regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers and hyphens only'),
  adminName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

// POST /api/auth/register
// Creates the school + first admin user in one transaction
export async function register(req, res) {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors })
  }

  const { schoolName, subdomain, adminName, email, password } = parsed.data

  // Check subdomain is available
  const { data: existing } = await supabase
    .from('schools')
    .select('id')
    .eq('subdomain', subdomain)
    .single()

  if (existing) {
    return res.status(409).json({ error: 'Subdomain already taken' })
  }

  // Create school
  const trialEndsAt = new Date()
trialEndsAt.setDate(trialEndsAt.getDate() + 14)

const { data: school, error: schoolError } = await supabase
  .from('schools')
  .insert({ 
    name: schoolName, 
    subdomain, 
    contact_email: email,
    trial_ends_at: trialEndsAt.toISOString(),
    status: 'trial'
  })
  .select()
  .single()

  if (schoolError) {
    return res.status(500).json({ error: 'Failed to create school' })
  }

  // Create admin user
  const passwordHash = await bcrypt.hash(password, 12)

  const { data: user, error: userError } = await supabase
    .from('users')
    .insert({
      school_id: school.id,
      name: adminName,
      email,
      password_hash: passwordHash,
      role: 'admin',
    })
    .select()
    .single()

  if (userError) {
    return res.status(500).json({ error: 'Failed to create admin user' })
  }

  const token = signToken(user, school)

  return res.status(201).json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    school: { id: school.id, name: school.name, subdomain: school.subdomain },
  })
}

// POST /api/auth/login
export async function login(req, res) {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid email or password format' })
  }

  const { email, password } = parsed.data

  const { data: user } = await supabase
    .from('users')
    .select('*, schools(*)')
    .eq('email', email)
    .single()

  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' })
  }

  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password' })
  }

  const token = signToken(user, user.schools)

  return res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    school: { id: user.schools.id, name: user.schools.name, subdomain: user.schools.subdomain },
  })
}

// GET /api/auth/me
export async function me(req, res) {
  const { data: user } = await supabase
    .from('users')
    .select('id, name, email, role, school_id, schools(name, subdomain)')
    .eq('id', req.user.id)
    .single()

  if (!user) return res.status(404).json({ error: 'User not found' })

  return res.json(user)
}

function signToken(user, school) {
  return jwt.sign(
    {
      id: user.id,
      school_id: school.id,
      role: user.role,
      name: user.name,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  )
}
