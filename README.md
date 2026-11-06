# Leaving Zero — Workshop

Responsive GitHub Pages frontend with Supabase accounts, server-enforced owner approval, private file storage, and per-user calendar subscriptions.

## First launch

1. GitHub Pages is configured to publish with **GitHub Actions**. The source repository was made public with the owner's explicit approval. Publishing the interface does not publish band records or audio.
2. Portal address and Supabase Auth Site URL: **https://workshop.leavingzero.com/**. This exact address is also an allowed Auth redirect. The original GitHub Pages redirect remains allowed for earlier links.
3. Create an account at the deployed portal using **chris@leavingzero.com**, choose your own password, and confirm the email. Only this confirmed address receives owner privileges. No owner password or login was created for you.
4. Invite other members to visit the same address, register, confirm email, then wait for your approval under Members. Guest accounts can read but not change shared records.
5. If confirmation mail is rejected for non-team addresses, configure a production SMTP provider in Supabase Auth → Emails. Supabase's default mail service is restricted. Do not disable email verification.

The interface is publicly downloadable. Band records, files, roster emails, audit history, and personal presets remain protected on the backend. No secret keys or private audio belong in this repository.

## Implemented

- Shared UTC calendar: rehearsals, gigs, unavailability, local time display and yes/maybe/no RSVPs.
- Per-user revocable iCal subscription links for Apple, Google and Outlook, plus .ics snapshot export. Calendar changes are read-only subscriptions and refresh at each app's own polling interval.
- Song catalog, secure stem uploads, synchronized multi-channel Web Audio mixer, mute/solo/volume/pan, transport/seek/loop/speed and personal mix presets.
- Ordered, versioned setlists with previous revisions; rehearsal notes.
- Suggestions/comments/status, member-created polls/deadlines with one changeable vote per member.
- Tasks, gear/patch notes, secure stage/show files, shared USD financial ledger.
- Member dashboard with recent updates, owner-controlled membership, guest/suspended roles, owner-only audit history.

## Backend already provisioned

Supabase project: qzshtwrrqfuyqtfceygn

- Five tables in non-exposed workshop_private schema, RLS enabled and direct client table access revoked.
- Public security-invoker RPC wrapper calls the narrowly scoped, identity-checked private function. Roles never come from user-editable metadata. Owner recognition reads the verified auth.users email.
- New users start pending. Membership checks run for every operation. Guests cannot write. Only the owner can manage accounts; there is no delegated admin role.
- Private workshop-files bucket, 40 MB upload cap, MIME allowlist, member-only reads, approved writer-only uploads into their own ID prefix. No public or shared signed file URLs.
- Active workshop-calendar Edge Function. It accepts only a random 256-bit feed credential. Only the SHA-256 hash is stored. Its service-only database RPC checks membership every fetch.
- Calendar function platform JWT verification is deliberately disabled because calendar applications cannot send Supabase JWTs. It authenticates with the personal feed token instead. The service-role key is read from Supabase's built-in server environment and never sent to the browser.

bootstrap.sql and hardening.sql record the remote migration SQL in application order. They have already been applied: do not replay them on this project. Later changes should be appended as new migrations through the Supabase migration tools. SQL test fixtures are synthetic and wrapped in BEGIN/ROLLBACK.

## Development

Node 22.13+ required.

    npm ci
    npm test
    npm run dev
    npm run build

Local URL: http://127.0.0.1:5173/

Only publishable project configuration is included in src/config.ts; optional VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY overrides are documented in .env.example. VITE_ values are public. Never use a service-role/secret key there.

The GitHub Actions workflow builds/tests on pull requests and publishes main to Pages. It requires no repository secrets. Backend schema/function deployments use the connected Supabase tools and are separate from the frontend workflow.

For a custom domain, change Vite's base path to / (or set PAGES_BASE_PATH when building), configure GitHub Pages DNS/custom domain, and add the exact new address to Supabase Auth's Site/Redirect URLs. Do not add broad wildcard redirects. The existing leavingzero.com public website and the original Sites deployment are unchanged.

## Calendar privacy

Create a link under Calendar → Your calendar subscription. Copy it into the calendar app's subscribe-from-URL field. Treat it as a credential: anyone who obtains it can read the calendar. No audio or attachments are in feeds. Rotating/revoking the link or suspending the member blocks future fetches, but cannot erase copies already downloaded. Tokens are shown once after generation and not persisted in browser storage.

Google OAuth two-way sync is not implemented. It requires a Google OAuth client/consent configuration, encrypted refresh-token storage, calendar mappings, conflict/deletion rules, and webhook renewal. No Google secrets are needed for iCal subscriptions.

## Media architecture and limits

Stems must share the same DAW start point. All decoded sources use one AudioContext clock. Playback fetches private files with the current user's session and retains decoded audio in browser memory. Authorized listeners can still download or record audio; this is not DRM.

40 MB per uploaded file, 120 MB combined source data per player load. Browser decode support varies. Speed changes pitch; pitch-preserving time stretching and seamless sample-accurate loop boundaries are not implemented. Wave bars are illustrative, not analyzed waveforms. Large multitrack sessions need a future streaming/worklet player. Real band stems still need listening tests on the band's devices.

Account suspension does not remove audio already downloaded into a listener's memory. Clear/close the page to discard a local session. No permanent account deletion, malware scanning, resumable uploads or file replacement/deletion UI is implemented.

## Other limits

- Notifications are in-app status messages and recent dashboard activity with 60-second refresh; email/push/deadline alerts are not implemented.
- Shared finances are a USD ledger visible to all approved members, including guests; this is not payment processing/accounting.
- Task assignees are free text. Use polls for song voting.
- Audit captures actor/action/time and setlist revisions, not an external tamper-proof compliance log.
- No existing Sites records/audio were migrated. Keep the original deployment until any data you want has been transferred.
- Configure backups and storage retention before relying on this as your only archive.

## Verification

Production frontend build and TypeScript checks pass. Calendar tests cover escaping/injection, UTF-8 folding, stable IDs, revisions and UTC timestamps. Backend rolled-back SQL tests pass for owner recognition, pending accounts, admin isolation, persistence, conflicting edits, unique votes, audit/roster email privacy, guest write rejection, suspension, token access, and direct table/function privileges. Supabase security advisors return no findings. Package audit after updating Vite reports zero known vulnerabilities.

Local browser login layout was inspected. User email delivery, real member account sessions, mobile devices and private audio playback need final acceptance testing after Pages is enabled.
