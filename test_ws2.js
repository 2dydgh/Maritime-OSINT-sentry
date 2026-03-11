const WebSocket = require('ws');
const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

ws.on('open', function open() {
  console.log('Connected');
  ws.send(JSON.stringify({
    APIKey: "09ddd1152c7c42eabd7a2b69aa4b4f4f59b54d14",
    BoundingBoxes: [[[-90, -180], [90, 180]]],
    FilterMessageTypes: ["PositionReport"]
  }));
});

ws.on('message', function incoming(data) {
  console.log('Received:', JSON.parse(data));
  process.exit(0);
});

ws.on('error', function error(err) {
  console.error('Error:', err);
  process.exit(1);
});

ws.on('close', function close() {
  console.log('Disconnected');
});
