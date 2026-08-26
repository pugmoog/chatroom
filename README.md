# Pugmoog Chat

Accountless, ephemeral chats and personal messages. Messages and uploaded images expire after 48 hours; browser identities that remain inactive for 60 days are permanently removed with their owned chat.

Enable GitHub Pages for the repository after the first push. The site expects to be served at `https://pugmoog.github.io/chatroom/` and calls the backend at `https://d3txi12i3pqbxm.cloudfront.net/chat/api`.

The static frontend is in the repository root. Deployable backend source and service configuration are under `server/`; the production copy runs from `/opt/pugmoog-chat` and stores its SQLite database and private image files in `/var/lib/pugmoog-chat`.
