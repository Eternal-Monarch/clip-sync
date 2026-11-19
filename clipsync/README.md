# ClipSync

Private, real-time clipboard sharing between your own devices. Pure HTML + CSS + vanilla JS, hosted on
GitHub Pages, with Supabase (free tier) for auth, database and Realtime.

## 1. Create the Supabase backend (about 5 minutes)

1. Create a free project at <https://supabase.com>.
2. **SQL Editor → New query**, paste all of `supabase-schema.sql`, click **Run**.
   This creates `clips`, `devices`, `user_settings`, triggers, Row Level Security policies,
   the Realtime publication, and the presence-channel policies.
3. **Authentication → Sign In / Providers → Email**: keep Email enabled and turn **off** "Confirm email"
   (personal project; the built-in mailer is heavily rate-limited).
4. Start the app (step 2 below), tap **Sign in → Create account** once with your email and a strong password.
5. Back in **Authentication → Sign In / Providers**, turn **off "Allow new users to sign up"**.
   From now on nobody else can register on your project.
6. *(Recommended)* **Realtime → Settings**: turn off "Allow public access" so only authorised private channels work.

## 2. Configure and run

1. **Project Settings → API**: copy the **Project URL** and the **anon / publishable key**.
2. Put them in `js/config.js`. The anon key is public by design (Row Level Security protects the data).
   **Never** put the `service_role` key anywhere in this project.
3. Run locally (service workers and the Clipboard API need `localhost` or HTTPS):
   ```
   python -m http.server 8080      # then open http://localhost:8080
   ```

## 3. Deploy to GitHub Pages

1. Create a GitHub repo and push the contents of this folder to the root of the `main` branch.
2. **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*, Branch = `main` / `(root)`.
3. Open `https://<your-user>.github.io/<repo>/` on the laptop **and** on the phone, and sign in with the same account.
4. Android: Chrome menu → **Install app** (or use the in-app Install button).

All paths are relative, so it works under the `/<repo>/` sub-path.

## 4. How it works

| Concern | Implementation |
|---|---|
| Local storage | IndexedDB (`clips`, `meta`); localStorage only for preferences. In-memory fallback if IndexedDB is blocked. |
| Outbox | A clip with `_dirty = 1` is pending. New clips are upserted whole (client UUID = idempotent, no duplicates); existing clips send only changed fields, so a pin on one device and a favorite on another both survive. |
| Real-time | Supabase `postgres_changes` filtered by `user_id`. On reconnect/visibility/online a catch-up pull (`updated_at` cursor with a 2-minute overlap) guarantees nothing is missed. |
| Conflicts | Field-level merge; timestamps (`updated_at`) are set by the database trigger, never by the client. |
| Deletes | Soft delete: the server erases the text immediately and keeps an empty tombstone for 30 days so offline devices learn about it. |
| Presence | Private Realtime channel `clipsync:<user_id>` plus a 45 s heartbeat (`last_seen_at`). A device counts as online only while present or seen in the last 90 s. |
| Notifications | In-app toast + badge + optional chime; browser notifications via the service worker (Android Chrome doesn't support `new Notification()`). |
| Security | RLS on every table (`user_id = auth.uid()`), `anon` role has no access, signups disabled, text rendered with `textContent` only. |

## 5. Honest limitations

- **Closed-app notifications need Web Push**, which requires a push server (e.g. a Supabase Edge Function with VAPID keys). Not included; browser notifications work while the app is open or recently backgrounded.
- Supabase stores clip text unencrypted at rest on their side. RLS keeps other users out, but not the project owner or Supabase. Don't paste secrets you wouldn't store in a database.
- Free Supabase projects pause after about a week of inactivity; resume from the dashboard.
- The browser cannot delete your auth user. Do that from **Authentication → Users** in the dashboard.
- Android may suspend a backgrounded tab's WebSocket; the app catches up the moment it is foregrounded.
- Passwords are the account boundary. Use a strong, unique one.

## 6. Test checklist

1. **Laptop → phone**: paste text on the laptop, Ctrl+Enter; the phone shows a toast and the clip; tap **Copy**, paste elsewhere.
2. **Phone → laptop**: same in reverse.
3. **Offline**: DevTools → Network → Offline, send a clip (shows *Pending*), go online (it syncs, chip disappears).
4. **Refresh / restart**: history persists.
5. **Security**: sign out, then in the console `supabase` queries return nothing; a second account sees none of your clips.
6. **Devices**: rename the phone from the laptop; close the phone tab and watch it go offline within ~90 s.

## 7. Files

```
index.html  manifest.webmanifest  service-worker.js  supabase-schema.sql
css/styles.css
js/config.js      Supabase URL + anon key
js/app.js         state, events, rendering orchestration
js/supabase.js    client + auth helpers
js/sync.js        outbox, pull, realtime, presence, devices, cloud operations
js/storage.js     IndexedDB + preferences
js/clipboard.js   validation, copy with fallback, clip factory
js/notifications.js  toasts, badge, chime, browser notifications
js/ui.js          cards, linkify, dialogs, menu, theme
vendor/supabase.js   vendored Supabase SDK (works offline)
assets/icons/*
```
(`database.js` from the original plan is folded into `sync.js` to keep cloud operations next to the logic that uses them.)
