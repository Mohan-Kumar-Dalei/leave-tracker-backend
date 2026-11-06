# Leave Tracker API

Node, Express and MongoDB backend for the Leave Tracker. The React frontend lives in [leave-tracker-frontend](https://github.com/Mohan-Kumar-Dalei/leave-tracker-frontend).

## Run it locally

You need Node 20 or newer and MongoDB running on `localhost:27017`.

```bash
npm install
cp .env.example .env
```

Fill in `JWT_ACCESS_SECRET`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` and `SEED_EMPLOYEE_PASSWORD`, then:

```bash
npm run seed:demo
npm run dev
```

`npm run seed` creates only the leave types, holidays and the first admin. `seed:demo` also adds sample employees and leaves, and refuses to run in production. Run it again to reset the sample leaves.

The API runs on `http://localhost:5000`. Without SMTP settings, mails are saved as HTML files in `.mail-outbox/`.

```bash
npm test
```

The tests use a separate `leave_tracker_test` database on the same MongoDB.

## Leave rules

- Weekends (`WEEKEND_DAYS`) and public holidays inside a leave are not counted. Restricted holidays are.
- Half days work for a single date only.
- Available is entitled minus approved minus waiting, so waiting requests hold their days.
- Balances are calculated from leave records, never stored as a counter.
- Requests cannot overlap, cross a year end, or exceed the balance. Leave Without Pay has no limit.
- Restricted holiday leave must be on a restricted holiday, once per holiday.
- Absent on the dashboard is the number of approved Leave Without Pay days.
- Employees can cancel a waiting request, or an approved one that has not started. Admins can cancel any approved leave.
- An admin cannot decide their own request while another active admin exists, and the last active admin cannot be removed.

## Security

| Area | What is in place |
| --- | --- |
| Headers | helmet with a strict CSP, HSTS once `COOKIE_SECURE=true` |
| Rate limits | Separate limits for the API, sign in, password mails and new requests, plus nginx |
| Sessions | Short access JWT and rotating refresh token in httpOnly SameSite=Strict cookies, stolen refresh token detection |
| Passwords | bcrypt cost 12, length and content rules, account lock after 5 failures, same error for unknown emails |
| CSRF | SameSite=Strict cookies plus an Origin allowlist on every write |
| Input | Strict zod schemas on every route, MongoDB operator stripping, 32 KB body limit, escaped search patterns |
| Access | User reloaded on each request, so deactivation and password changes apply at once |
| Output | No hashes in JSON, escaped HTML in mails, CSV formula neutralising, no stack traces in production |

## API

All routes are under `/api`. Everything except sign in and password reset needs a session.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/auth/login`, `/auth/logout`, `/auth/refresh` | Session |
| POST | `/auth/forgot-password`, `/auth/reset-password`, `/auth/change-password` | Passwords |
| GET | `/auth/me` | Current user |
| GET | `/me/summary`, `/me/leaves`, `/me/leaves.csv` | Employee dashboard data |
| POST | `/leaves/preview`, `/leaves` | Check and apply |
| PATCH | `/leaves/:id/cancel` | Cancel |
| GET, POST, PATCH | `/leave-types` | Leave types, writes are admin only |
| GET, POST, PATCH, DELETE | `/holidays` | Holidays, writes are admin only |
| GET, PATCH | `/notifications`, `/notifications/read-all`, `/notifications/:id/read` | Bell |
| GET | `/notifications/stream` | Live updates |
| GET | `/admin/overview`, `/admin/leaves`, `/admin/leaves.csv`, `/admin/calendar` | Admin views |
| PATCH | `/admin/leaves/:id/review` | Approve or reject |
| GET, POST, PATCH | `/admin/employees` | People |
| POST | `/admin/employees/:id/invite`, `/admin/employees/:id/adjustments` | Invite link, balance change |

## Deploy

See [docs/AWS_DEPLOY.md](docs/AWS_DEPLOY.md).
