// sockets/wsHub.js
let wss = null;

function init(serverWss) {
  wss = serverWss;
}

function broadcastToSession(session_code, payload) {
  if (!wss) return;
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (
      client.readyState === 1 /* OPEN */ &&
      client.subscribedSession === session_code
    ) {
      client.send(msg);
    }
  });
}

module.exports = { init, broadcastToSession };
