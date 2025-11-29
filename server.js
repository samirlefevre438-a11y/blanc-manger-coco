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
  if(type==="carte"){ 
    fs.appendFileSync("cartes.txt","\n"+texte); 
    cartes.push(texte); 
  } else { 
    fs.appendFileSync("textequestion.txt","\n"+texte); 
    questions.push(texte); 
  }
  res.send({success:true});
});

// Salon
const salon = {
  joueurs: {},
  cartesPosees: [],
  phase: "jeu", // jeu | vote | resultat
  questionActuelle: null,
  changementCarteVotes: [],
  partieEnCours: false
};

// --- Fonctions utilitaires ---
function tirerMainsUnique(nbParJoueur){
  let pile = [...cartes];
  pile.sort(()=>Math.random()-0.5);
  const mains = {};
  const ids = Object.keys(salon.joueurs);
  
  for(const id of ids){
    mains[id] = [];
    for(let i=0; i<nbParJoueur && pile.length>0; i++){
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

// --- Démarrer une nouvelle partie ---
function demarrerPartie(){
  if(Object.keys(salon.joueurs).length < 2) return; // Minimum 2 joueurs
  
  salon.partieEnCours = true;
  salon.cartesPosees = [];
  salon.phase = "jeu";
  salon.changementCarteVotes = [];
  
  const mains = tirerMainsUnique(7);
  Object.entries(salon.joueurs).forEach(([id,j])=>{
    j.main = mains[id] || [];
    j.peutJouer = true;
    j.vote = null;
  });
  
  nouvelleQuestion();
  io.emit("etatSalon", salon);
  io.emit("question", salon.questionActuelle);
  Object.entries(salon.joueurs).forEach(([id,j])=> {
    io.to(id).emit("main", j.main);
  });
}

// --- Nouveau tour (après vote) ---
function nouveauTour(){
  salon.cartesPosees = [];
  salon.phase = "jeu";
  salon.changementCarteVotes = [];
  
  const mains = tirerMainsUnique(7);
  Object.entries(salon.joueurs).forEach(([id,j])=>{
    j.main = mains[id] || [];
    j.peutJouer = true;
    j.vote = null;
  });
  
  nouvelleQuestion();
  io.emit("etatSalon", salon);
  io.emit("question", salon.questionActuelle);
  Object.entries(salon.joueurs).forEach(([id,j])=> {
    io.to(id).emit("main", j.main);
  });
}

// --- Connexion socket ---
io.on("connection", socket=>{
  console.log("🟢 Nouveau joueur :", socket.id);

  socket.on("rejoindreSalon", pseudo=>{
    if(!pseudo) return;
    
    const nouvelleConnexion = !salon.joueurs[socket.id];
    
    salon.joueurs[socket.id] = { 
      pseudo, 
      main: [], 
      peutJouer: true, 
      points: salon.joueurs[socket.id]?.points || 0,
      vote: null 
    };
    
    io.emit("etatSalon", salon);
    io.emit("chatMessage", `🟢 ${pseudo} a rejoint la partie`);
    
    // Démarrer automatiquement si 2+ joueurs et pas de partie en cours
    if(!salon.partieEnCours && Object.keys(salon.joueurs).length >= 2){
      demarrerPartie();
    } else if(salon.partieEnCours) {
      // Envoyer l'état actuel au nouveau joueur
      socket.emit("question", salon.questionActuelle);
      if(salon.phase === "vote"){
        socket.emit("phaseVote", salon.cartesPosees.map(c=>c.carte));
      } else {
        socket.emit("cartesPosees", salon.cartesPosees.map(c=>({carte:c.carte, pseudo:salon.joueurs[c.socketId]?.pseudo})));
      }
    }
  });

  socket.on("poserCarteIndex", index=>{
    const j = salon.joueurs[socket.id];
    if(!j || !j.peutJouer || salon.phase!=="jeu") return;
    if(index<0 || index>=j.main.length) return;

    const carte = j.main.splice(index,1)[0];
    j.peutJouer = false;
    salon.cartesPosees.push({
      carte, 
      socketId: socket.id, 
      pseudo: j.pseudo,
      votes: 0
    });

    socket.emit("main", j.main);
    io.emit("cartesPosees", salon.cartesPosees.map(c=>({
      carte: c.carte,
      pseudo: c.pseudo
    })));

    // Vérifier si tous ont joué
    const joueursActifs = Object.values(salon.joueurs).filter(j => j.main.length > 0);
    if(joueursActifs.every(j => !j.peutJouer)){
      salon.phase = "vote";
      // Mélanger les cartes pour l'anonymat
      salon.cartesPosees.sort(() => Math.random() - 0.5);
      io.emit("phaseVote", salon.cartesPosees.map(c => c.carte));
    }
  });

  socket.on("changerMain", ()=>{
    const j = salon.joueurs[socket.id];
    if(!j || salon.phase!=="jeu" || !j.peutJouer) return;

    let pile = [...cartes];
    // Retirer les cartes déjà en main chez les autres joueurs
    Object.entries(salon.joueurs).forEach(([id,other])=>{ 
      if(id !== socket.id) {
        pile = pile.filter(c => !other.main.includes(c)); 
      }
    });

    const nouvelleMain = [];
    for(let i=0; i<7 && pile.length>0; i++){
      const idx = Math.floor(Math.random()*pile.length);
      nouvelleMain.push(pile[idx]);
      pile.splice(idx,1);
    }
    j.main = nouvelleMain;
    socket.emit("main", j.main);
    io.emit("chatMessage", `🔄 ${j.pseudo} a changé sa main`);
  });

  socket.on("voter", index=>{
    if(salon.phase !== "vote") return;
    const j = salon.joueurs[socket.id];
    if(!j || j.vote !== null) return;
    if(index < 0 || index >= salon.cartesPosees.length) return;

    // Empêcher de voter pour sa propre carte
    if(salon.cartesPosees[index].socketId === socket.id){
      socket.emit("chatMessage", "⚠️ Tu ne peux pas voter pour ta propre carte !");
      return;
    }

    salon.cartesPosees[index].votes += 1;
    j.vote = index;

    // Vérifier si tout le monde a voté
    const joueursActifs = Object.values(salon.joueurs).filter(j => j.main.length >= 0);
    if(joueursActifs.every(j => j.vote !== null)){
      salon.phase = "resultat";
      
      let maxVotes = Math.max(...salon.cartesPosees.map(c => c.votes));
      let gagnants = salon.cartesPosees.filter(c => c.votes === maxVotes);
      
      gagnants.forEach(c => {
        if(salon.joueurs[c.socketId]){
          salon.joueurs[c.socketId].points += 1;
        }
      });

      const gagnantsData = gagnants.map(c => ({
        socketId: c.socketId,
        pseudo: c.pseudo,
        carte: c.carte,
        votes: c.votes
      }));

      // Envoyer résultats avant de reset
      io.emit("resultatVote", {
        gagnants: gagnantsData,
        cartesPosees: salon.cartesPosees
      });
      io.emit("etatSalon", salon);

      // Annoncer le(s) gagnant(s)
      const nomsGagnants = gagnantsData.map(g => g.pseudo).join(", ");
      io.emit("chatMessage", `🏆 ${nomsGagnants} ${gagnants.length > 1 ? 'ont gagné' : 'a gagné'} ce tour !`);

      // Nouveau tour après 3 secondes
      setTimeout(() => {
        nouveauTour();
        io.emit("nouveauTour", { salon });
      }, 3000);
    }
  });

  socket.on("changerQuestion", ()=>{
    if(salon.changementCarteVotes.includes(socket.id)) return;
    salon.changementCarteVotes.push(socket.id);

    const nbJoueurs = Object.keys(salon.joueurs).length;
    if(salon.changementCarteVotes.length > nbJoueurs / 2){
      nouvelleQuestion();
      salon.changementCarteVotes = [];
      io.emit("question", salon.questionActuelle);
      io.emit("chatMessage", "🔄 Question changée !");
    }
  });

  socket.on("deconnexion", ()=>{
    const pseudo = salon.joueurs[socket.id]?.pseudo;
    delete salon.joueurs[socket.id];
    if(pseudo) io.emit("chatMessage", `🔴 ${pseudo} a quitté la partie`);
    io.emit("etatSalon", salon);
    
    // Si moins de 2 joueurs, mettre en pause
    if(Object.keys(salon.joueurs).length < 2){
      salon.partieEnCours = false;
    }
  });

  socket.on("disconnect", ()=>{
    const pseudo = salon.joueurs[socket.id]?.pseudo;
    delete salon.joueurs[socket.id];
    if(pseudo) io.emit("chatMessage", `🔴 ${pseudo} s'est déconnecté`);
    io.emit("etatSalon", salon);
    
    if(Object.keys(salon.joueurs).length < 2){
      salon.partieEnCours = false;
    }
  });

  socket.on("chatMessage", msg=>{
    const j = salon.joueurs[socket.id];
    if(j && msg.trim() !== ""){
      io.emit("chatMessage", `${j.pseudo}: ${msg.trim()}`);
    }
  });
});

// --- Démarrage serveur ---
nouvelleQuestion();
server.listen(3000, ()=>console.log("🚀 Serveur sur http://localhost:3000"));