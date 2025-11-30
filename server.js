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
  phase: "jeu", // jeu | presentation | vote | resultat
  questionActuelle: null,
  changementCarteVotes: [],
  partieEnCours: false,
  carteActuelle: 0 // Index de la carte en cours de présentation
};

// --- Fonctions utilitaires ---
function piocherCartes(nbCartes, cartesAExclure = []){
  let pile = [...cartes];
  // Exclure les cartes déjà utilisées
  pile = pile.filter(c => !cartesAExclure.includes(c));
  pile.sort(() => Math.random() - 0.5);
  
  const main = [];
  for(let i = 0; i < nbCartes && pile.length > 0; i++){
    main.push(pile.shift());
  }
  return main;
}

function getCartesEnJeu(){
  const cartesEnJeu = [];
  Object.values(salon.joueurs).forEach(j => {
    cartesEnJeu.push(...j.main);
  });
  return cartesEnJeu;
}

function nouvelleQuestion(){ 
  salon.questionActuelle = questions[Math.floor(Math.random()*questions.length)];
}

// --- Démarrer une nouvelle partie ---
function demarrerPartie(){
  if(Object.keys(salon.joueurs).length < 2) return;
  
  salon.partieEnCours = true;
  salon.cartesPosees = [];
  salon.phase = "jeu";
  salon.changementCarteVotes = [];
  
  // Donner 7 cartes à chaque joueur
  Object.entries(salon.joueurs).forEach(([id,j])=>{
    j.main = piocherCartes(7, []);
    j.peutJouer = true;
    j.vote = null;
  });
  
  nouvelleQuestion();
  io.emit("etatSalon", salon);
  io.emit("question", salon.questionActuelle);
  Object.entries(salon.joueurs).forEach(([id,j])=> {
    io.to(id).emit("main", j.main);
  });
  
  console.log("🎮 Partie démarrée avec", Object.keys(salon.joueurs).length, "joueurs");
}

// --- Nouveau tour (après vote) ---
function nouveauTour(){
  salon.cartesPosees = [];
  salon.phase = "jeu";
  salon.changementCarteVotes = [];
  salon.carteActuelle = 0;
  
  const cartesEnJeu = getCartesEnJeu();
  
  // Donner UNE nouvelle carte à chaque joueur qui a joué
  Object.entries(salon.joueurs).forEach(([id,j])=>{
    const nouvellesCarte = piocherCartes(1, cartesEnJeu);
    j.main.push(...nouvellesCarte);
    j.peutJouer = true;
    j.vote = null;
    console.log(`   ✓ ${j.pseudo}: reçoit 1 carte (total: ${j.main.length})`);
  });
  
  nouvelleQuestion();
  
  io.emit("etatSalon", salon);
  io.emit("question", salon.questionActuelle);
  
  // Envoyer les mains mises à jour
  Object.entries(salon.joueurs).forEach(([id,j])=> {
    io.to(id).emit("main", j.main);
  });
  
  console.log("🔄 Nouveau tour - 1 carte ajoutée à chaque joueur");
}

// --- Connexion socket ---
io.on("connection", socket=>{
  console.log("🟢 Nouveau joueur :", socket.id);

  socket.on("rejoindreSalon", pseudo=>{
    if(!pseudo) return;
    
    const estNouveauJoueur = !salon.joueurs[socket.id];
    
    // Créer ou mettre à jour le joueur
    if(estNouveauJoueur){
      salon.joueurs[socket.id] = { 
        pseudo, 
        main: [], 
        peutJouer: true, 
        points: 0,
        vote: null 
      };
      
      io.emit("chatMessage", `🟢 ${pseudo} a rejoint la partie`);
      
      // Si une partie est en cours, donner 7 cartes au nouveau joueur
      if(salon.partieEnCours){
        const cartesEnJeu = getCartesEnJeu();
        salon.joueurs[socket.id].main = piocherCartes(7, cartesEnJeu);
        socket.emit("main", salon.joueurs[socket.id].main);
        socket.emit("question", salon.questionActuelle);
        
        if(salon.phase === "vote"){
          socket.emit("phaseVote", salon.cartesPosees.map(c=>c.carte));
        } else {
          socket.emit("cartesPosees", salon.cartesPosees.map(c=>({
            carte:c.carte, 
            pseudo:salon.joueurs[c.socketId]?.pseudo
          })));
        }
        console.log(`   ✓ ${pseudo} rejoint en cours de partie: 7 cartes distribuées`);
      }
    }
    
    io.emit("etatSalon", salon);
    
    // Démarrer automatiquement si 2+ joueurs et pas de partie en cours
    if(!salon.partieEnCours && Object.keys(salon.joueurs).length >= 2){
      demarrerPartie();
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
    
    console.log(`🃏 ${j.pseudo} a posé une carte (reste ${j.main.length})`);
    
    // Envoyer mise à jour du nombre de cartes posées
    io.emit("nombreCartesAttente", salon.cartesPosees.length);

    // Vérifier si tous ont joué (sauf ceux qui n'ont pas de cartes)
    const joueursActifs = Object.values(salon.joueurs).filter(joueur => joueur.main.length > 0 || !joueur.peutJouer);
    const tousOntJoue = joueursActifs.every(joueur => !joueur.peutJouer);
    
    console.log(`🎴 Cartes posées: ${salon.cartesPosees.length}/${joueursActifs.length}`);
    
    if(tousOntJoue && salon.cartesPosees.length >= 2){
      salon.phase = "presentation";
      salon.carteActuelle = 0;
      // Mélanger les cartes pour l'anonymat
      salon.cartesPosees.sort(() => Math.random() - 0.5);
      // Envoyer la première carte
      io.emit("presentationCarte", {
        carte: salon.cartesPosees[0].carte,
        index: 0,
        total: salon.cartesPosees.length,
        question: salon.questionActuelle
      });
      console.log("📺 Phase de présentation commencée");
    }
  });

  socket.on("changerMain", ()=>{
    const j = salon.joueurs[socket.id];
    if(!j || salon.phase!=="jeu" || !j.peutJouer) return;

    const cartesEnJeu = getCartesEnJeu();
    const nouvelleMain = piocherCartes(7, cartesEnJeu);
    j.main = nouvelleMain;
    socket.emit("main", j.main);
    io.emit("chatMessage", `🔄 ${j.pseudo} a changé sa main`);
  });

  socket.on("carteSuivante", ()=>{
    if(salon.phase !== "presentation") return;
    
    salon.carteActuelle++;
    
    if(salon.carteActuelle >= salon.cartesPosees.length){
      // Toutes les cartes ont été présentées, passer au vote
      salon.phase = "vote";
      io.emit("phaseVote", salon.cartesPosees.map((c, i) => ({
        carte: c.carte,
        index: i
      })));
      console.log("🗳️  Phase de vote commencée");
    } else {
      // Envoyer la carte suivante
      io.emit("presentationCarte", {
        carte: salon.cartesPosees[salon.carteActuelle].carte,
        index: salon.carteActuelle,
        total: salon.cartesPosees.length,
        question: salon.questionActuelle
      });
    }
  });

  socket.on("voter", index=>{
    if(salon.phase !== "vote") return;
    const j = salon.joueurs[socket.id];
    if(!j || j.vote !== null) return;
    if(index < 0 || index >= salon.cartesPosees.length) return;

    salon.cartesPosees[index].votes += 1;
    j.vote = index;

    console.log(`✅ ${j.pseudo} a voté pour la carte ${index}`);

    // Vérifier si tout le monde a voté (uniquement ceux qui ont posé une carte)
    const joueursQuiOntJoue = Object.values(salon.joueurs).filter(joueur => 
      salon.cartesPosees.some(c => c.socketId === joueur.vote || c.socketId === Object.keys(salon.joueurs).find(id => salon.joueurs[id] === joueur))
    );
    
    // Plus simple: vérifier que tous les joueurs qui ont une main ont voté
    const joueursAvecMain = Object.values(salon.joueurs);
    const nbVotes = joueursAvecMain.filter(joueur => joueur.vote !== null).length;
    const tousOntVote = nbVotes === joueursAvecMain.length;
    
    console.log(`📊 Votes: ${nbVotes}/${joueursAvecMain.length}`);
    
    if(tousOntVote){
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

      // Envoyer résultats avant le nouveau tour
      io.emit("resultatVote", {
        gagnants: gagnantsData,
        cartesPosees: salon.cartesPosees
      });
      io.emit("etatSalon", salon);

      // Annoncer le(s) gagnant(s)
      const nomsGagnants = gagnantsData.map(g => g.pseudo).join(", ");
      io.emit("chatMessage", `🏆 ${nomsGagnants} ${gagnants.length > 1 ? 'ont gagné' : 'a gagné'} ce tour !`);

      console.log("🏆 Gagnants:", nomsGagnants);
      console.log("⏱️  Nouveau tour dans 3 secondes...");

      // Nouveau tour après 3 secondes
      setTimeout(() => {
        nouveauTour();
        io.emit("nouveauTour", { salon });
        console.log("✅ Nouveau tour lancé !");
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