import { supabase } from '../config/supabase.js'
import { z } from 'zod'

const classSchema = z.object({
  name: z.string().min(2),
  level: z.string().optional(),
  teacher_id: z.string().uuid().optional(),
})

export async function listClasses(req, res) {
  const { data, error } = await supabase
    .from('classes')
    .select('*, users(name, email)')
    .eq('school_id', req.user.school_id)
    .order('name')

  if (error) return res.status(500).json({ error: error.message })
  return res.json(data)
}

export async function createClass(req, res) {
  const parsed = classSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors })
  }

  const { data, error } = await supabase
    .from('classes')
    .insert({ ...parsed.data, school_id: req.user.school_id })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  return res.status(201).json(data)
}

export async function updateClass(req, res) {
  const allowed = ['name', 'level', 'teacher_id']
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  )

  const { data, error } = await supabase
    .from('classes')
    .update(updates)
    .eq('id', req.params.id)
    .eq('school_id', req.user.school_id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  return res.json(data)
}

export async function deleteClass(req, res) {
  const { error } = await supabase
    .from('classes')
    .delete()
    .eq('id', req.params.id)
    .eq('school_id', req.user.school_id)

  if (error) return res.status(500).json({ error: error.message })
  return res.json({ message: 'Class deleted' })
}
