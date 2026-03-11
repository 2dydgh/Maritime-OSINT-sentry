const WebSocket = require('ws');
const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

ws.on('open', function open() {
  console.log('Connected');
  // Use a very busy area, like the English Channel
  ws.send(JSON.stringify({
    APIKey: "09ddd1152c7c42eabd7a2b69aa4b4f4f59b54d14",
    BoundingBoxes: [[[50, -5], [52, 2]]]
  }));
});

ws.on('message', function incoming(data) {
  console.log('Received data length:', data.length);
  try {
     const parsed = JSON.parse(data);
     if(parsed.MessageType === "PositionReport"){
         console.log(parsed.Message.PositionReport);
         process.exit(0);
     }
  } catch(e){}
});

ws.on('error', function error(err) {
  console.error('Error:', err);
});
ws.on('close', function (code, reason) {
  console.log('Connection closed:', code, reason.toString());
});
setInterval(() => { console.log('Waiting...'); }, 5000);
