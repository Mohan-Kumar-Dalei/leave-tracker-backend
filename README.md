# Leave Tracker API

Node, Express and MongoDB backend for the Leave Tracker. The React frontend lives in [leave-tracker-frontend](https://github.com/Mohan-Kumar-Dalei/leave-tracker-frontend).

## Run it locally

You need Node 20 or newer and MongoDB running on `localhost:27017`.

```bash
npm install
cp .env.example .env
```

Fill in `JWT_ACCESS_SECRET`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD_HASH` and `SEED_EMPLOYEE_PASSWORD_HASH`, then:

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

## Importing the real team

Real names, emails and leave numbers stay out of Git. They live in `data/roster.local.json`, and the `data/` folder is ignored. Starting passwords are bcrypt hashes in `.env.passwords`, which is also ignored. Both formats are described at the top of `src/importRoster.js`.

```bash
npm run seed
npm run import:roster -- data/roster.local.json
```

Add `--remove-demo` to also delete the sample accounts. It can be run again: existing people keep their password and their monthly usage is replaced. No mail is sent.

Monthly usage from the old sheet has no dates, so it is stored as monthly totals in `ImportedUsage`. It counts against the balance and shows in the month by month chart, but not in the leave lists or the team calendar. The team calendar only shows leave applied for in this app.

## Leave rules

- Weekends (`WEEKEND_DAYS`) and public holidays inside a leave are not counted. Restricted holidays are.
- Half days work for a single date only.
- Available is entitled minus earlier usage, approved and pending days, so pending requests hold their days.
- Balances are calculated from leave records, never stored as a counter.
- Requests cannot overlap, cross a year end, or exceed the balance. Leave Without Pay has no limit.
- Restricted holiday leave must be on a restricted holiday, once per holiday.
- Absent on the dashboard is the number of Leave Without Pay days taken.
- Employees can cancel a waiting request, or an approved one that has not started. Admins can cancel any approved leave.
- An admin cannot decide their own request while another active admin exists, and the last active admin cannot be removed.

## Security

| Area | What is in place |
| --- | --- |
| Headers | helmet with a strict CSP, HSTS once `COOKIE_SECURE=true` |
| Rate limits | Separate limits for the API, sign in, password mails and new requests, plus nginx |
| Sessions | Short access JWT and rotating refresh token in httpOnly SameSite=Strict cookies, stolen refresh token detection |
| Passwords | Only bcrypt hashes are stored, cost 12, with length and content rules, account lock after 5 failures, same error for unknown emails. Login reads the hash from MongoDB, so a changed password takes effect at once |
| Secrets | Env files are read only at start up. No route or static folder serves files, and a test checks that |
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
| GET, PATCH | `/notifications`, `/notifications/read-all`, `/notifications/:id/read` | Bell, unread items only |
| GET | `/notifications/stream` | Live updates |
| GET | `/team-calendar` | Who is away in a month, shown to admins as a page and to employees in the calendar view of My leave. Names, dates and status only; admins also get the leave type |
| GET | `/admin/overview`, `/admin/schedule`, `/admin/leaves`, `/admin/leaves.csv` | Admin views |
| PATCH | `/admin/leaves/:id/review` | Approve or reject |
| GET, POST, PATCH | `/admin/employees` | Employees. The list leaves out admins. The admin sets the first password, and the employee can change it from Change password |
| POST, PATCH, DELETE | `/admin/employees/:id/adjustments` | Add, edit or remove a balance change. Days already booked cannot be taken away |
| PATCH | `/me/adjustments/:id/dismiss` | Close the balance change banner |

## Deploy

See [docs/AWS_DEPLOY.md](docs/AWS_DEPLOY.md).
