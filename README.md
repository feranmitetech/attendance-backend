# School Attendance System — Backend API

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment file and fill in your values
cp .env.example .env

# 3. Run in development mode (auto-restarts on file changes)
npm run dev

# 4. Production
npm start
```

## Environment variables

| Variable | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase dashboard → Project Settings → API |
| `SUPABASE_SERVICE_KEY` | Supabase dashboard → Project Settings → API → service_role key |
| `JWT_SECRET` | Generate: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `AT_API_KEY` | Africa's Talking dashboard → Settings → API Key |
| `AT_USERNAME` | Your Africa's Talking username (use "sandbox" for testing) |

## API endpoints

### Auth
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | Public | Create school + admin account |
| POST | `/api/auth/login` | Public | Login, returns JWT token |
| GET | `/api/auth/me` | Any | Get current user info |

### Students
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/students` | Any | List students (filter: ?class_id=, ?active=) |
| POST | `/api/students` | Admin | Enroll new student, generates QR code |
| GET | `/api/students/:id` | Any | Get single student |
| PATCH | `/api/students/:id` | Admin | Update student (incl. save face descriptor) |
| GET | `/api/students/:id/qr` | Any | Get QR code image for printing |

### Attendance
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/attendance/checkin` | Any | Check in via QR, face, or manual |
| POST | `/api/attendance/mark-absent` | Admin | Mark all no-shows absent + send SMS |
| GET | `/api/attendance` | Any | List records (filter: ?date=, ?class_id=, ?status=) |
| GET | `/api/attendance/summary` | Any | Today's present/absent/late counts |

### Classes
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/classes` | Any | List all classes |
| POST | `/api/classes` | Admin | Create class |
| PATCH | `/api/classes/:id` | Admin | Update class |
| DELETE | `/api/classes/:id` | Admin | Delete class |

## Check-in payload examples

**QR code scan:**
```json
POST /api/attendance/checkin
{ "method": "qr", "qr_code": "school-uuid:STU-7X9K2" }
```

**Face recognition (student matched on frontend):**
```json
POST /api/attendance/checkin
{ "method": "face", "student_id": "student-uuid-here" }
```

**Manual override by teacher:**
```json
POST /api/attendance/checkin
{ "method": "manual", "student_id": "student-uuid-here", "status": "present" }
```

## Deployment (Railway)

1. Push this folder to a GitHub repo
2. Create a new project on railway.app
3. Connect your GitHub repo
4. Add all environment variables in Railway's dashboard
5. Railway auto-deploys on every git push

Your API will be live at: `https://your-project.railway.app`
