import express from 'express';
import cors from 'cors';
import { Socket } from 'socket.io';
const SocketIO = require('socket.io');

type DocID = string;
type ClientID = string;
type SocketID = string;

interface chatMessage {
  docId: DocID;
  senderId: ClientID;
  senderName: string;
  message: string;
}

const PORT = 4000;
const app = express();
app.use(cors());

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const io = SocketIO(server, {
  cors: true,
  origins: '*:*',
});

app.get('/', (req: express.Request, res: express.Response) =>{
  res.send('start');
});


const state: Record<DocID, Set<Socket>> = {
};

const book: Record<SocketID, DocID> = {
};

io.on('connection', (socket: Socket) => {
  console.log('user connected');

  socket.on('disconnect', () => {
    const docId: DocID = book[socket.id];
    if (!(docId in state)) {
      return;
    }

    console.log('user disconnected');

    state[docId].delete(socket);
    if (state[docId].size == 0) {
      delete state[docId];
    }

    delete book[socket.id];

    const stateSize = (docId in state) ? state[docId].size : 0;
    console.log(`state size: ${stateSize}`);
    console.log(`book size: ${Object.keys(book).length}`);
  });

  const register = (msg: chatMessage) => {
    console.log(`Register message from ${msg.docId} name ${msg.senderName} id ${msg.senderId}`);
    book[socket.id] = msg.docId;
    if (!state[msg.docId]) {
      state[msg.docId] = new Set<Socket>();
    }
    state[msg.docId].add(socket);

    console.log(`state size: ${state[msg.docId].size}`)
    console.log(`book size: ${Object.keys(book).length}`)
  };

  /*
   * If the chat server came back up after a failure, the client cannot receive any messages
   * until they emit an event to the server, at which point the server setup the connection again
   */
  socket.on('chat-register', register);
  socket.on('chat-message', (msg: chatMessage) => {
    if (!(socket.id in book)) {
      register(msg);
    }
    console.log(`message from ${msg.docId} name ${msg.senderName} id ${msg.senderId}: ${msg.message}`);
    for (let sock of state[msg.docId]) {
      sock.emit('chat-message', msg);
    }
  });
})
