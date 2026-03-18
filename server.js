const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================================
// CARD ENGINE
// ============================================================
const SUITS = ['♥','♦','♠','♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const RANK_ORDER = {A:1,2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function buildDeck() {
  let id=0, cards=[];
  for (let d=0; d<2; d++) {
    for (const suit of SUITS)
      for (const rank of RANKS)
        cards.push({rank,suit,id:id++,isJoker:false});
    cards.push({rank:'JOKER',suit:'★',id:id++,isJoker:true});
  }
  return shuffle(cards);
}

function cardPoints(c) {
  if (c.isJoker) return 25;
  if (['J','Q','K','A'].includes(c.rank)) return 10;
  return parseInt(c.rank);
}

function handPoints(hand) { return hand.reduce((s,c)=>s+cardPoints(c),0); }

function trySet(nonJokers) {
  const ranks = new Set(nonJokers.map(c=>c.rank));
  if (ranks.size!==1) return false;
  const sc={};
  for (const c of nonJokers) sc[c.suit]=(sc[c.suit]||0)+1;
  return !Object.values(sc).some(v=>v>2);
}

function checkConsec(sorted, jokers, total) {
  if (!sorted.length) return true;
  const seen=new Set();
  for (const r of sorted){if(seen.has(r))return false;seen.add(r);}
  const span=sorted[sorted.length-1]-sorted[0]+1;
  const gaps=span-sorted.length;
  return gaps<=jokers && span+(jokers-gaps)===total;
}

function tryRun(nonJokers, jokerCount, total) {
  if (new Set(nonJokers.map(c=>c.suit)).size!==1) return false;
  const ranks=nonJokers.map(c=>RANK_ORDER[c.rank]||parseInt(c.rank)).sort((a,b)=>a-b);
  if (ranks.includes(1)) {
    if (checkConsec(ranks,jokerCount,total)) return true;
    return checkConsec(ranks.map(r=>r===1?14:r).sort((a,b)=>a-b),jokerCount,total);
  }
  return checkConsec(ranks,jokerCount,total);
}

function isValidMeld(cards) {
  if (cards.length<3) return {valid:false,reason:'Min 3 karte'};
  const jokers=cards.filter(c=>c.isJoker);
  const nonJ=cards.filter(c=>!c.isJoker);
  if (!nonJ.length) return {valid:false,reason:'Ne može samo jokeri'};
  if (trySet(nonJ)) return {valid:true,type:'set'};
  if (tryRun(nonJ,jokers.length,cards.length)) return {valid:true,type:'run'};
  return {valid:false,reason:'Nevažeća kombinacija'};
}

function meldPoints(cards) { return cards.reduce((s,c)=>s+cardPoints(c),0); }

// ============================================================
// ROOMS
// ============================================================
const rooms = {};

function makeCode() {
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join('');
}

function createMatch(room) {
  const n=room.players.length;
  const firstIdx=room.matchNum%n;
  const deck=buildDeck();
  let idx=0;
  room.players.forEach((p,i)=>{
    p.hand=deck.slice(idx,idx+(i===firstIdx?15:14));
    p.opened=false;
    idx+=(i===firstIdx?15:14);
  });
  const rest=deck.slice(idx);
  room.discard=[rest.pop()];
  room.deck=rest;
  room.tableMelds=[];
  room.currentTurn=firstIdx;
  room.phase='draw';
  room.matchActive=true;
}

function stateFor(room,i) {
  return {
    type:'state',
    roomCode:room.code,
    status:room.status,
    players:room.players.map((p,pi)=>({
      name:p.name,
      handCount:p.hand.length,
      opened:p.opened,
      hand:pi===i?p.hand:null,
    })),
    tableMelds:room.tableMelds,
    deckCount:room.deck?room.deck.length:0,
    discardTop:room.discard&&room.discard.length?room.discard[room.discard.length-1]:null,
    currentTurn:room.currentTurn,
    phase:room.phase,
    round:room.round,
    matchNum:room.matchNum,
    totalScores:room.totalScores,
    scoreHistory:room.scoreHistory,
    myIndex:i,
  };
}

function broadcast(room,fn) {
  room.players.forEach((p,i)=>{
    if(p.ws&&p.ws.readyState===1) p.ws.send(JSON.stringify(fn(i)));
  });
}

function broadcastState(room){ broadcast(room,i=>stateFor(room,i)); }
function bToast(room,msg,t=''){broadcast(room,()=>({type:'toast',msg,toastType:t}));}

function endMatch(room,winnerIdx,fromHand){
  const scores=room.players.map((p,i)=>{
    if(i===winnerIdx) return fromHand?-140:-40;
    const pts=handPoints(p.hand);
    if(fromHand) return p.opened?pts*2:200;
    return pts;
  });
  scores.forEach((s,i)=>{room.totalScores[i]+=s;room.scoreHistory[i].push(s);});
  room.matchActive=false;
  const isLast=room.matchNum>=(3*room.players.length)-1;
  broadcast(room,i=>({
    type:'matchEnd',scores,totalScores:room.totalScores,
    scoreHistory:room.scoreHistory,winnerIdx,fromHand,
    isGameOver:isLast,myIndex:i,
    players:room.players.map(p=>p.name),
  }));
  if(!isLast){
    setTimeout(()=>{
      room.matchNum++;
      room.round=Math.floor(room.matchNum/room.players.length)+1;
      createMatch(room);
      broadcastState(room);
      bToast(room,'Nova partija počinje!','success');
    },8000);
  } else {
    room.status='gameover';
  }
}

function reshuffleDeck(room){
  if(room.discard.length<=1)return;
  const top=room.discard.pop();
  room.deck=shuffle(room.discard);
  room.discard=[top];
}

function handleAction(room,pi,msg){
  if(!room.matchActive)return;
  const cp=room.players[pi];
  if(room.currentTurn!==pi){
    if(cp.ws)cp.ws.send(JSON.stringify({type:'toast',msg:'Nije tvoj red!',toastType:'error'}));
    return;
  }
  const {action,cardIds,meldIndex}=msg;
  const getCards=ids=>ids?ids.map(id=>cp.hand.find(c=>c.id===id)).filter(Boolean):[];
  const removeCards=cards=>{const ids=new Set(cards.map(c=>c.id));cp.hand=cp.hand.filter(c=>!ids.has(c.id));};
  const err=m=>{if(cp.ws)cp.ws.send(JSON.stringify({type:'toast',msg:m,toastType:'error'}));};

  if(action==='drawDeck'){
    if(room.phase!=='draw')return;
    if(!room.deck.length)reshuffleDeck(room);
    if(!room.deck.length){err('Špil prazan!');return;}
    cp.hand.push(room.deck.pop());
    room.phase='action';
    broadcastState(room);
  } else if(action==='drawDiscard'){
    if(room.phase!=='draw')return;
    if(!room.discard.length)return;
    cp.hand.push(room.discard.pop());
    room.phase='action';
    broadcastState(room);
  } else if(action==='playMeld'){
    if(room.phase==='draw')return;
    const cards=getCards(cardIds);
    if(cards.length<3){err('Min 3 karte');return;}
    const v=isValidMeld(cards);
    if(!v.valid){err(v.reason);return;}
    if(!cp.opened){
      const pts=meldPoints(cards);
      if(pts<51){err(`Trebate 51+ bod (imate ${pts})`);return;}
      cp.opened=true;
    }
    room.tableMelds.push({cards:[...cards],owner:pi,type:v.type});
    removeCards(cards);
    room.phase='discard';
    if(!cp.hand.length){endMatch(room,pi,false);return;}
    broadcastState(room);
    bToast(room,`${cp.name} otvorio kombinaciju!`,'success');
  } else if(action==='addToMeld'){
    if(room.phase==='draw')return;
    if(!cp.opened){err('Prvo se otvori');return;}
    if(meldIndex==null||!room.tableMelds[meldIndex])return;
    const cards=getCards(cardIds);
    const meld=room.tableMelds[meldIndex];
    const newCards=[...meld.cards,...cards];
    const v=isValidMeld(newCards);
    if(!v.valid){err(v.reason);return;}
    meld.cards=newCards;
    removeCards(cards);
    room.phase='discard';
    if(!cp.hand.length){endMatch(room,pi,false);return;}
    broadcastState(room);
    bToast(room,`${cp.name} dodao karte`,'');
  } else if(action==='swapJoker'){
    if(!cp.opened)return;
    if(!cardIds||cardIds.length!==1)return;
    if(meldIndex==null||!room.tableMelds[meldIndex])return;
    const myCard=cp.hand.find(c=>c.id===cardIds[0]);
    if(!myCard||myCard.isJoker)return;
    const meld=room.tableMelds[meldIndex];
    const ji=meld.cards.findIndex(c=>c.isJoker);
    if(ji<0){err('Nema jokera u meldu');return;}
    const nc=[...meld.cards];nc[ji]=myCard;
    const v=isValidMeld(nc);
    if(!v.valid){err('Zamjena nije moguća');return;}
    const jokerCard=meld.cards[ji];
    meld.cards=nc;
    cp.hand=cp.hand.filter(c=>c.id!==myCard.id);
    cp.hand.push(jokerCard);
    broadcastState(room);
    bToast(room,`${cp.name} zamijenio joker!`,'');
  } else if(action==='discard'){
    if(room.phase==='draw')return;
    if(!cardIds||cardIds.length!==1)return;
    const card=cp.hand.find(c=>c.id===cardIds[0]);
    if(!card)return;
    room.discard.push(card);
    cp.hand=cp.hand.filter(c=>c.id!==card.id);
    if(!cp.hand.length){endMatch(room,pi,false);return;}
    room.currentTurn=(room.currentTurn+1)%room.players.length;
    room.phase='draw';
    broadcastState(room);
    bToast(room,`${room.players[room.currentTurn].name} na potezu`,'');
  }
}

// ============================================================
// WEBSOCKET
// ============================================================
wss.on('connection',(ws)=>{
  let roomCode=null, pi=null;

  ws.on('message',(raw)=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}

    if(msg.type==='createRoom'){
      const code=makeCode();
      rooms[code]={
        code,status:'waiting',
        players:[{name:msg.name,hand:[],opened:false,ws}],
        deck:[],discard:[],tableMelds:[],
        currentTurn:0,phase:'draw',round:1,matchNum:0,
        totalScores:[0],scoreHistory:[[]],
        maxPlayers:msg.maxPlayers||4,matchActive:false,
      };
      roomCode=code;pi=0;
      ws.send(JSON.stringify({type:'created',roomCode:code,playerIndex:0}));
    } else if(msg.type==='joinRoom'){
      const room=rooms[msg.roomCode];
      if(!room){ws.send(JSON.stringify({type:'error',msg:'Soba ne postoji'}));return;}
      if(room.status!=='waiting'){ws.send(JSON.stringify({type:'error',msg:'Igra već počela'}));return;}
      if(room.players.length>=room.maxPlayers){ws.send(JSON.stringify({type:'error',msg:'Soba puna'}));return;}
      const idx=room.players.length;
      room.players.push({name:msg.name,hand:[],opened:false,ws});
      room.totalScores.push(0);room.scoreHistory.push([]);
      roomCode=msg.roomCode;pi=idx;
      ws.send(JSON.stringify({type:'joined',roomCode:msg.roomCode,playerIndex:idx}));
      broadcastState(room);
    } else if(msg.type==='startGame'){
      const room=rooms[roomCode];
      if(!room||pi!==0)return;
      if(room.players.length<2){ws.send(JSON.stringify({type:'toast',msg:'Min 2 igrača',toastType:'error'}));return;}
      room.status='playing';
      createMatch(room);
      broadcastState(room);
      bToast(room,'Igra počinje!','success');
    } else if(msg.type==='action'){
      const room=rooms[roomCode];
      if(room)handleAction(room,pi,msg);
    }
  });

  ws.on('close',()=>{
    const room=rooms[roomCode];
    if(!room)return;
    const p=room.players[pi];
    if(p)p.ws=null;
    broadcast(room,()=>({type:'toast',msg:`${p?.name||'Igrač'} se odspojio`,toastType:'error'}));
  });
});

const PORT=process.env.PORT||10000;
server.listen(PORT,()=>console.log(`DodigRemi running on port ${PORT}`));
