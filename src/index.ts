import dotenv from 'dotenv';
import fs from 'fs';
import https from 'https';
import express from 'express';
import cors from 'cors';
import { Socket } from 'socket.io';
const SocketIO = require('socket.io');

dotenv.config();

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

const privateKey = fs.readFileSync(process.env.PRIVATE_KEY as string, 'utf8');
const certificate = fs.readFileSync(process.env.CERTIFICATE as string, 'utf8');
const ca = fs.readFileSync(process.env.CA as string, 'utf8');

const credentials = {
    key: privateKey,
    cert: certificate,
    ca: ca,
};

const server = https.createServer(credentials, app).listen(PORT, () => {
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

class VoicePeerMultimap{
  private multimap:{[idx:string]:Set<string>};
  constructor(){
    this.multimap={};
  }
  add(idx:string, entry:string){
    if(!(idx in this.multimap))
      this.multimap[idx] = new Set<string>();
    this.multimap[idx].add(entry);
  }
  has(idx:string, entry:string){
    if(!(idx in this.multimap))
      return false;
    return this.multimap[idx].has(entry);
  }
  delete(idx:string, entry:string){
    if(!(idx in this.multimap))
      return false;
    return this.multimap[idx].delete(entry);
  }
  forEach(idx:string, lambda:(val:string)=>void){
    if(!(idx in this.multimap))
      return;
    for(var el of this.multimap[idx]){
      lambda(el);
    }
  }
  getSet(idx:string){
    if(!(idx in this.multimap))
      return new Set<string>();
    else
      return new Set<string>(this.multimap[idx]);
  }
  getList(idx:string){
    if(!(idx in this.multimap))
      return []
    return [...this.multimap[idx]]
  }
}
const map_d2s:VoicePeerMultimap = new VoicePeerMultimap();
const map_s2d:VoicePeerMultimap = new VoicePeerMultimap();
const map_c2s:{[cid:string]:string}={};
const map_s2n:{[cid:string]:string}={};
const sockets:{[sid:string]:Socket} = {};
type RTC_JSON_join = {did:string;cid:string;nick:string};
type RTC_JSON_whois = {sid:string};
type RTC_JSON_fwd = {sid:string;[other:string]:any};

io.on('connection', (socket: Socket) => {
  const sid:SocketID = socket.id;
  var joined:boolean = false;
  var did:DocID ='';
  var cid:ClientID ='';


  const register_forward_callback = (cmd:string)=>{
    socket.on(cmd, (data:RTC_JSON_fwd)=>{
      const peer_sid:SocketID = data['sid'];
      if(!map_s2d.has(peer_sid,did))
        return;
      data['sid'] = sid;
      sockets[peer_sid].emit(cmd,data);
    })
  }
  const on_peer_quit = ()=>{
    if(!joined)
      return;
    
      map_d2s.delete(did,sid);
      map_s2d.delete(sid,did);
      if(sid==map_c2s[cid])
        delete map_c2s[cid];
      joined=false;
      
      map_d2s.forEach(did,(peer_sid:SocketID)=>{
        sockets[peer_sid].emit("peer del",sid);
      });
      console.log(`vc quit: peer ${sid} / doc ${did}`)
      delete sockets[sid];
      delete map_s2n[sid];
  }

  register_forward_callback('rtc offer');
  register_forward_callback('rtc answer');
  register_forward_callback('rtc iceCandidate');

  socket.on('peer list',()=>{
    
    socket.emit("result peer list", map_d2s.getList(did));
  });
  socket.on('peer join',(data:RTC_JSON_join)=>{
    if(joined)
      return;
    
    sockets[sid] = socket;
    did = data['did'];
    cid = data['cid'];
    const nick = data['nick'];
    var peers = map_d2s.getSet(did);
    if((cid in map_c2s) && (map_c2s[cid] in sockets)){
      var prev_sid:SocketID = map_c2s[cid];
      map_d2s.forEach(did,(peer_sid:SocketID)=>{
        sockets[peer_sid].emit("peer kick",prev_sid);
        peers.delete(prev_sid);
      })
    }
    map_d2s.forEach(did,(peer_sid:SocketID)=>{
      sockets[peer_sid].emit("peer new",sid);
    })
    map_d2s.add(did,sid);
    map_s2d.add(sid,did);

    map_c2s[cid]=sid;
    map_s2n[sid]=nick;
    joined=true;
    peers.add(sid);

    socket.emit("result peer join", {me:sid,list:[...peers]});
    console.log(`vc join: peer ${sid} / nick ${nick} / doc ${did}`)
  });
  socket.on('peer whois',(data:RTC_JSON_whois)=>{
    if(!joined)
      return;
    const query_sid:string = data['sid'];
    var query_nick:string = map_s2n[query_sid];
    socket.emit("result peer whois", {sid:query_sid,nick:query_nick})
  })
  socket.on('peer quit',on_peer_quit);
  socket.on('disconnect',on_peer_quit);
})
