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

// Notation:
// d for document ID
// c for client ID
// n for Nickname
// s for socket
type ClientDocumentID = string;
type Nickname = string;
type RTC_JSON_join = {did:string;cid:string;nick:string};
type RTC_JSON_whois = {cid:string};
type RTC_JSON_nick = {new_nick:string};
type RTC_JSON_fwd = {cid:string;[other:string]:any};

const map_d2c:VoicePeerMultimap = new VoicePeerMultimap();
const map_c2d:VoicePeerMultimap = new VoicePeerMultimap();
const map_cd2n:{[cd:string]:Nickname}={};
const map_cd2s:{[cd:string]:Socket} = {};

var to_cd = function(cid:ClientID, did:DocID){
  return cid+did;
}

var debugout= function(...args:any[]){
  console.log(...args);
}
io.on('connection', (socket: Socket) => {
  var joined:boolean = false;
  var did:DocID ='';
  var cid:ClientID ='';
  var cdid:ClientDocumentID = '';

  const register_forward_callback = (cmd:string)=>{
    socket.on(cmd, (data:RTC_JSON_fwd)=>{
      const peer_cid:ClientID = data['cid'];
      if(!map_c2d.has(peer_cid,did))
        return;
      data['cid'] = cid;
      map_cd2s[to_cd(peer_cid,did)].emit(cmd,data);
      debugout(`forward ${cmd} from ${cid} to ${peer_cid}.`)
    })
  }
  const on_peer_quit = ()=>{
    if(!joined)
      return;
    
    // if this connection is valid
    if(map_cd2s[cdid]==socket){
      map_d2c.delete(did,cid);
      map_c2d.delete(cid,did);
      map_d2c.forEach(did,(peer_cid:SocketID)=>{
        map_cd2s[to_cd(peer_cid,did)].emit("peer del",cid);
      });
      delete map_cd2s[cdid];
      delete map_cd2n[cdid];
    }
    joined=false;
    debugout(`peer ${cid} quit from ${did}.`)
  }

  register_forward_callback('rtc offer');
  register_forward_callback('rtc answer');
  register_forward_callback('rtc iceCandidate');

  socket.on('peer list',()=>{
    
    socket.emit("result peer list", map_d2c.getList(did));
    // debugout(`peer ${cid} request list of peers in ${did}, and it was [${map_d2c.getList(did)}]`)

  });
  
  socket.on('peer rename',(data:RTC_JSON_nick)=>{
    if(map_cd2n[cdid] == data.new_nick) return;
    
    map_cd2n[cdid] = data.new_nick;
    map_d2c.forEach(did,(peer_cid:ClientID)=>{
      map_cd2s[to_cd(peer_cid,did)].emit("peer rename",cid);
    })
    debugout(`peer ${cid} renamed in ${did}.`)
  });
  socket.on('peer join',(data:RTC_JSON_join)=>{
    if(joined)
      return;
    
    did = data['did'];
    cid = data['cid'];
    cdid = to_cd(cid,did);
    const nick = data['nick'];
    const already_joined = cdid in map_cd2s;

    if(already_joined){
      map_d2c.forEach(did,(peer_cid:ClientID)=>{
        map_cd2s[to_cd(peer_cid,did)].emit("peer kick",cid);
      })
      debugout(`kicked ${cid} from ${did}.`)
    }
    else{
      map_d2c.add(did,cid);
      map_c2d.add(cid,did);
    }
    map_cd2s[cdid] = socket;
    map_cd2n[cdid] = nick;
    map_d2c.forEach(did,(peer_cid:ClientID)=>{
      map_cd2s[to_cd(peer_cid,did)].emit("peer new",cid);
    })
    joined=true;
    
    const peers = map_d2c.getSet(did);
    socket.emit("result peer join", {me:cid,list:[...peers]});
    debugout(`peer ${cid}(aka ${nick}) joined in ${did}. Current peers: [${[...peers]}]`)
  });
  socket.on('peer whois',(data:RTC_JSON_whois)=>{
    if(!joined)
      return;
    const query_cid:ClientID = data['cid'];
    const query_cdid:ClientDocumentID = to_cd(query_cid,did);
    if(query_cdid in map_cd2n){
      const query_nick:Nickname = map_cd2n[query_cdid];
      socket.emit("result peer whois", {cid:query_cid,nick:query_nick})
      debugout(`peer ${cid} request nickname of ${query_cid} in ${did}, and it was ${query_nick}.`)
    }
  })
  socket.on('peer quit',on_peer_quit);
  socket.on('disconnect',on_peer_quit);
})
