# Company CRM Upgrade — Implementation Notes

Upstream: huangguojia/GoodJob
Fork: zzlongcheng-web/GoodJob
Development branch: feature/company-crm-upgrade
Baseline: ff254f8c363448da70d07f3b22d9574334028828

## Product rules

1. WhatsApp accounts are personal to each salesperson. A salesperson may only list, read, send from, or manage their own account and conversations. A manager read-only view must be implemented through an explicit CRM permission claim; do not trust a client-supplied role. Keep realtime events scoped to the account owner and only add manager rooms after server-side authorization.
2. Sales users may not delete customers, leads, customer activities, or communication history. Corrections should be append-only audit events or supervisor-reviewed archive operations. Retention must not silently erase original message evidence.
3. Monthly KPI target: at least 61 distinct newly developed companies with qualifying two-way communication in the calendar month. Count one company once per month. Exclude companies whose first-development date predates the month. A sent message, unanswered call, or manually typed note alone is not qualifying evidence. Evidence should be an inbound customer reply or an answered call with provider-confirmed duration, tied to a customer and actor. Keep daily new outbound calls as a secondary activity metric.
4. Weekly prospecting: company owner selects one or more countries each week. The saved run must freeze that country list into its execution snapshot. Schedule defaults to Saturday 09:00 America/New_York, and uses IANA timezone rules so DST is handled. Owner may edit countries before the next run, pause, or run once. Search strategy/campaign approval and paid-provider cost approval remain mandatory.
5. Voice: add a provider-neutral call interface. The first provider can be Twilio Voice, subject to account credentials, verified caller ID, local calling rules, consent and recording-law checks. Persist call SID, actor, customer, E.164 destination, direction, status, start/end, duration, recording URL, transcript status, and webhook verification result. A click-to-call intent is not proof that a call connected.

## Changes already committed

- Removed lead.delete and customer.delete from legacy sales permissions.
- Added customer.activity.delete as a critical manager-level permission.
- Added backend guards to customer activity DELETE and lead soft/permanent DELETE routes.
- Added IAM permission assertions for sales and manager roles.

## Required follow-up work

### WhatsApp authorization
- Extend the CRM-to-plugin identity assertion to include a signed, short-lived permission/scope claim or a server-side introspection call.
- Keep account owner as the default access boundary.
- Implement manager read-only scope (org_subtree/tenant) without granting send, connect, logout, or delete.
- Check every HTTP route, background automation, media download, history import, and Socket.IO event against the same authorization policy.
- Add tests for Alice/Bob isolation, manager read-only access, manager send denial, owner transfer, revoked sessions, and realtime event leakage.

### KPI
- Add immutable customer first-developed timestamp and stable organization/company dedupe key.
- Add communication evidence table/event model with provider IDs and verified inbound/answered states.
- Aggregate distinct customer/company IDs by team, owner, and calendar month.
- Add API and dashboard: target 61, actual, remaining, evidence drill-down, excluded old customers, and audit trail.
- Add tests for month boundaries, duplicate contacts at same company, outbound-only, inbound replies, answered calls, imported history, and reassignment.

### Country schedule
- Extend schedule schema with dayOfWeek, localTime, and countries (or a versioned campaign/strategy snapshot).
- Add an owner/manager-controlled edit endpoint that updates the schedule revision and recomputes nextRunAt.
- On execution, pass a validated query-plan override with the selected countries, or create a strategy revision whose fingerprint includes countries. Do not mutate a previously approved strategy invisibly.
- Add frontend country multi-select and next-run preview.
- Test Saturday 09:00 in EST and EDT, edits, pause/resume, duplicate schedules, and country snapshot immutability.

### Voice
- Define VoiceProvider interface and Twilio adapter; add signed webhook routes and idempotent event processing.
- Store calls separately from manually authored activity notes; write a linked immutable activity only after provider event verification.
- Add permissions communication.call and communication.recording.read.
- Add tests using mocked provider webhooks; no real calls in CI.

## Validation status

GitHub contents API commits were created for the initial permission and route guards. Build and test suites have not yet been run in this environment. Do not deploy to production until the full backend build, IAM tests, lead deletion tests, customer activity tests, WhatsApp ownership tests, and MySQL migration tests pass.
