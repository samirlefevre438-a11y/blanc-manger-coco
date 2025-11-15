const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const bodyParser = require("body-parser");

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use(bodyParser.json());

// Chargement cartes et questions
let cartes = fs.readFileSync("cartes.txt", "utf8")
  .split("\n").map(l => l.trim()).filter(l => l.length>0);
let questions = fs.readFileSync("textequestion.txt","utf8")
  .split("\n").map(l => l.trim()).filter(l => l.length>0);

console.log(`📦 ${cartes.length} cartes et ${questions.length} questions chargées.`);

// Endpoint ajout carte/question
app.post("/ajouterCarte", (req,res)=>{
  const { type, texte } = req.body;
  if(!texte || !type || !["carte","question"].includes(type)) return res.status(400).send("Mauvais format");
  if(type==="carte"){ fs.appendFileSync("cartes.txt","\n"+texte); cartes.push(texte); }
  else { fs.appendFileSync("textequestion.txt","\n"+texte); questions.push(texte); }
  res.send({success:true});
});

// Salon
const salon = {
  joueurs: {},
  cartesPosees: [],
  phase: "jeu",
  questionActuelle: null,
  changementCarteVotes: []
};

// --- Fonctions utilitaires ---
function tirerMainsUnique(nbParJoueur){
  let pile = [...cartes];
  pile.sort(()=>Math.random()-0.5);
  const mains = {};
  const ids = Object.keys(salon.joueurs);
  for(const id of ids){
    mains[id] = [];
    for(let i=0;i<nbParJoueur;i++){
      if(pile.length===0) break;
      const index = Math.floor(Math.random()*pile.length);
      mains[id].push(pile[index]);
      pile.splice(index,1);
    }
  }
  return mains;
}

function nouvelleQuestion(){ 
  salon.questionActuelle = questions[Math.floor(Math.random()*questions.length)];
}

// --- Fonction reset si joueur rejoint/quitte ---
function resetJeu(){
  salon.cartesPosees=[];
  salon.phase="jeu";
  salon.changementCarteVotes=[];
  const mains = tirerMainsUnique(7);
  Object.entries(salon.joueurs).forEach(([id,j])=>{
    j.main = mains[id] || [];
    j.peutJouer = true;
    j.vote = null;
    j.points = j.points || 0;
  });
  nouvelleQuestion();
  io.emit("etatSalon", salon);
  io.emit("question", salon.questionActuelle);
  Object.entries(salon.joueurs).forEach(([id,j])=> io.to(id).emit("main", j.main));
}

// --- Connexion socket ---
io.on("connection", socket=>{
  console.log("🟢 Nouveau joueur :", socket.id);

  socket.on("rejoindreSalon", pseudo=>{
    if(!pseudo) return;
    salon.joueurs[socket.id] = { pseudo, main: [], peutJouer:true, points:0, vote:null };
    resetJeu();
  });

  socket.on("poserCarteIndex", index=>{
    const j = salon.joueurs[socket.id];
    if(!j || !j.peutJouer || salon.phase!=="jeu") return;
    if(index<0 || index>=j.main.length) return;

    const carte = j.main.splice(index,1)[0];
    j.peutJouer=false;
    salon.cartesPosees.push({carte, socketId: socket.id, votes:0});

    socket.emit("main", j.main);
    io.emit("cartesPosees", salon.cartesPosees.map(c=>({carte:c.carte})));

    if(Object.values(salon.joueurs).every(j=>!j.peutJouer)){
      salon.phase="vote";
      io.emit("phaseVote", salon.cartesPosees.map(c=>c.carte));
    }
  });

  socket.on("changerMain", ()=>{
    const j = salon.joueurs[socket.id];
    if(!j || salon.phase!=="jeu" || !j.peutJouer) return;

    let pile = [...cartes];
    Object.entries(salon.joueurs).forEach(([id,other])=>{ if(id!==socket.id) pile = pile.filter(c => !other.main.includes(c)); });

    const nouvelleMain=[];
    for(let i=0;i<7;i++){
      if(pile.length===0) break;
      const idx = Math.floor(Math.random()*pile.length);
      nouvelleMain.push(pile[idx]);
      pile.splice(idx,1);
    }
    j.main = nouvelleMain;
    socket.emit("main", j.main);
  });

  socket.on("voter", index=>{
    if(salon.phase!=="vote") return;
    const j = salon.joueurs[socket.id];
    if(!j || j.vote!==null) return;

    salon.cartesPosees[index].votes+=1;
    j.vote=index;

    if(Object.values(salon.joueurs).every(j=>j.vote!==null)){
      let maxVotes = Math.max(...salon.cartesPosees.map(c=>c.votes));
      let gagnants = salon.cartesPosees.filter(c=>c.votes===maxVotes);
      gagnants.forEach(c=>salon.joueurs[c.socketId].points+=1);

      const gagnantsData = gagnants.map(c=>({socketId:c.socketId}));

      resetJeu();
      io.emit("nouveauTour", {salon, gagnants:gagnantsData});
    }
  });

  socket.on("changerQuestion", ()=>{
    if(salon.changementCarteVotes.includes(socket.id)) return;
    salon.changementCarteVotes.push(socket.id);

    if(salon.changementCarteVotes.length > Object.keys(salon.joueurs).length/2){
      nouvelleQuestion();
      salon.changementCarteVotes=[];
      io.emit("question", salon.questionActuelle);
    }
  });

  socket.on("deconnexion", ()=>{
    delete salon.joueurs[socket.id];
    resetJeu();
  });

  socket.on("disconnect", ()=>{
    delete salon.joueurs[socket.id];
    resetJeu();
  });

  socket.on("chatMessage", msg=>{
    const j = salon.joueurs[socket.id];
    if(j && msg.trim()!=="") io.emit("chatMessage", `${j.pseudo}: ${msg.trim()}`);
  });
});

// --- Démarrage serveur ---
nouvelleQuestion();
server.listen(3000, ()=>console.log("🚀 Serveur sur http://localhost:3000"));
