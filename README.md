# Walkie-Talkie Rooms

A multi-party, push-to-talk (walkie-talkie) web application with rooms, authentication, guest access, and mobile-friendly PWA support.

## Features

- Push-to-talk voice communication between multiple participants in a room (WebRTC).
- Create multiple rooms: open (public) or closed (password-protected).
- User accounts (username/password) and guest access to open rooms.
- Mobile-responsive UI + installable PWA (manifest + service worker).
- REST API + Socket.io signaling for integration with a native mobile app.

## Run

```bash
npm install
npm start
```

Then open http://localhost:3000

Environment variables:
- `PORT` (default 3000)
- `JWT_SECRET` (change in production)

## Mobile app integration

- REST:
  - `POST /api/register`, `POST /api/login` -> `{ token, user }`
  - `GET /api/rooms`, `POST /api/rooms`, `DELETE /api/rooms/:id`
  - `POST /api/rooms/:id/join` -> `{ room, displayName, isGuest }`
- Socket.io (connect with `token` query or in join payload):
  - `join-room`, `leave-room`
  - WebRTC signaling: `offer`, `answer`, `ice-candidate`
  - PTT: `ptt:start`, `ptt:stop` and events `ptt:granted`, `ptt:denied`, `ptt:talking`, `ptt:stopped`
  - Presence: `room-joined`, `peer-joined`, `peer-left`

A dedicated mobile page is available at `/` (responsive). For a native app, reuse the same endpoints and signaling events.