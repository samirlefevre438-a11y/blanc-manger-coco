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

console.log(📦 ${cartes.length} cartes et ${questions.length} questions chargées.);

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
  carteActuelle: 0, // Index de la carte en cours de présentation
  joueursPresCarteActuelle: [], // IDs des joueurs ayant cliqué sur "Suivant"
  questionsUtilisees: [], // Questions déjà utilisées
  cartesEnCirculation: [] // Toutes les cartes actuellement dans les mains des joueurs
};

// --- Fonctions utilitaires ---
function piocherCartes(nbCartes, cartesAExclure = []){
  let pile = [...cartes];
  // Exclure les cartes déjà utilisées ET celles en circulation
  const toutesCartesAExclure = [...cartesAExclure, ...salon.cartesEnCirculation];
  pile = pile.filter(c => !toutesCartesAExclure.includes(c));
  
  // Si pas assez de cartes disponibles, réinitialiser (utiliser toutes les cartes)
  if(pile.length < nbCartes){
    console.log("⚠️  Pas assez de cartes uniques, réinitialisation...");
    pile = [...cartes];
    // Exclure seulement celles en main actuellement
    pile = pile.filter(c => !salon.cartesEnCirculation.includes(c));
  }
  
  pile.sort(() => Math.random() - 0.5);
  
  const main = [];
  for(let i = 0; i < nbCartes && pile.length > 0; i++){
    const carte = pile.shift();
    main.push(carte);
    // Ajouter à la circulation
    if(!salon.cartesEnCirculation.includes(carte)){
      salon.cartesEnCirculation.push(carte);
    }
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
  // Filtrer les questions non utilisées
  let questionsDisponibles = questions.filter(q => !salon.questionsUtilisees.includes(q));
  
  // Si toutes les questions ont été utilisées, réinitialiser
  if(questionsDisponibles.length === 0){
    console.log("🔄 Toutes les questions utilisées, réinitialisation !");
    salon.questionsUtilisees = [];
    questionsDisponibles = [...questions];
  }
  
  // Choisir une question aléatoire parmi les disponibles
  salon.questionActuelle = questionsDisponibles[Math.floor(Math.random() * questionsDisponibles.length)];
  
  // Ajouter à la liste des questions utilisées
  salon.questionsUtilisees.push(salon.questionActuelle);
  
  console.log(📋 Question sélectionnée (${salon.questionsUtilisees.length}/${questions.length} utilisées));
}

// --- Démarrer une nouvelle partie ---
function demarrerPartie(){
  if(Object.keys(salon.joueurs).length < 2) return;
  
  salon.partieEnCours = true;
  salon.cartesPosees = [];
  salon.phase = "jeu";
  salon.changementCarteVotes = [];
  salon.cartesEnCirculation = [];
  
  // Donner 7 cartes UNIQUES à chaque joueur
  Object.entries(salon.joueurs).forEach(([id,j])=>{
    j.main = piocherCartes(7, []);
    j.peutJouer = true;
    j.vote = null;
    console.log(   ✓ ${j.pseudo}: 7 cartes uniques (Total en circulation: ${salon.cartesEnCirculation.length}));
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
  salon.joueursPresCarteActuelle = [];
  
  // Mettre à jour la liste des cartes en circulation
  salon.cartesEnCirculation = getCartesEnJeu();
  
  // Donner UNE nouvelle carte UNIQUE à chaque joueur
  Object.entries(salon.joueurs).forEach(([id,j])=>{
    const nouvellesCarte = piocherCartes(1, []);
    j.main.push(...nouvellesCarte);
    j.peutJouer = true;
    j.vote = null;
    console.log(   ✓ ${j.pseudo}: +1 carte unique (total: ${j.main.length}));
  });
  
  // Mettre à jour après distribution
  salon.cartesEnCirculation = getCartesEnJeu();
  
  nouvelleQuestion();
  
  io.emit("etatSalon", salon);
  io.emit("question", salon.questionActuelle);
  
  // Envoyer les mains mises à jour
  Object.entries(salon.joueurs).forEach(([id,j])=> {
    io.to(id).emit("main", j.main);
  });
  
  console.log(🔄 Nouveau tour - Cartes en circulation: ${salon.cartesEnCirculation.length}/${cartes.length});
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
      
      io.emit("chatMessage", 🟢 ${pseudo} a rejoint la partie);
      
      // Si une partie est en cours, donner 7 cartes au nouveau joueur
      if(salon.partieEnCours){
        salon.joueurs[socket.id].main = piocherCartes(7, []);
        salon.cartesEnCirculation = getCartesEnJeu(); // Mettre à jour
        socket.emit("main", salon.joueurs[socket.id].main);
        socket.emit("question", salon.questionActuelle);
        
        // Envoyer l'état actuel selon la phase
        if(salon.phase === "presentation"){
          // Envoyer la carte en cours de présentation
          socket.emit("presentationCarte", {
            carte: salon.cartesPosees[salon.carteActuelle].carte,
            index: salon.carteActuelle,
            total: salon.cartesPosees.length,
            question: salon.questionActuelle
          });
        } else if(salon.phase === "vote"){
          // Envoyer les cartes pour voter
          socket.emit("phaseVote", salon.cartesPosees.map(c => c.carte));
        } else if(salon.phase === "jeu"){
          // Envoyer le nombre de cartes posées
          socket.emit("nombreCartesAttente", salon.cartesPosees.length);
        }
        
        console.log(   ✓ ${pseudo} rejoint en cours de partie (phase: ${salon.phase}): 7 cartes distribuées);
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
    if(!j || !j.peutJouer || salon.phase!=="jeu") {
      console.log(❌ Impossible de poser: peutJouer=${j?.peutJouer}, phase=${salon.phase});
      return;
    }
    if(index<0 || index>=j.main.length) return;

    const carte = j.main.splice(index,1)[0];
    
    // Retirer la carte de la circulation (elle est maintenant posée)
    const circIndex = salon.cartesEnCirculation.indexOf(carte);
    if(circIndex > -1) salon.cartesEnCirculation.splice(circIndex, 1);
    
    j.peutJouer = false;
    salon.cartesPosees.push({
      carte, 
      socketId: socket.id, 
      pseudo: j.pseudo,
      votes: 0
    });

    socket.emit("main", j.main);
    
    console.log(🃏 ${j.pseudo} a posé "${carte}" (reste ${j.main.length} en main));
    
    // Envoyer mise à jour du nombre de cartes posées
    io.emit("nombreCartesAttente", salon.cartesPosees.length);

    // Vérifier si tous ont joué (sauf ceux qui n'ont pas de cartes)
    const tousLesJoueurs = Object.values(salon.joueurs);
    const joueursQuiOntJoue = tousLesJoueurs.filter(joueur => !joueur.peutJouer);
    
    console.log(📊 Joueurs total: ${tousLesJoueurs.length});
    console.log(📊 Joueurs qui ont joué: ${joueursQuiOntJoue.length});
    console.log(🎴 Cartes posées: ${salon.cartesPosees.length});
    
    tousLesJoueurs.forEach(joueur => {
      console.log(   - ${joueur.pseudo}: peutJouer=${joueur.peutJouer}, cartes=${joueur.main.length});
    });
    
    const tousOntJoue = tousLesJoueurs.every(joueur => !joueur.peutJouer);
    
    console.log(✅ Tous ont joué? ${tousOntJoue});
    
    if(tousOntJoue && salon.cartesPosees.length >= 2){
      salon.phase = "presentation";
      salon.carteActuelle = 0;
      salon.joueursPresCarteActuelle = []; // Reset des clics
      // Mélanger les cartes pour l'anonymat
      salon.cartesPosees.sort(() => Math.random() - 0.5);
      
      console.log("📺 ========== PASSAGE EN PHASE PRÉSENTATION ==========");
      console.log("📺 Question actuelle:", salon.questionActuelle);
      console.log("📺 Première carte:", salon.cartesPosees[0].carte);
      console.log("📺 Envoi de la première carte...");
      
      // Envoyer la première carte
      const dataToSend = {
        carte: salon.cartesPosees[0].carte,
        index: 0,
        total: salon.cartesPosees.length,
        question: salon.questionActuelle,
        joueursQuiOntClique: 0,
        totalJoueurs: Object.keys(salon.joueurs).length
      };
      
      console.log("📺 Données à envoyer:", JSON.stringify(dataToSend));
      console.log("📺 Nombre de clients connectés:", io.sockets.sockets.size);
      
      io.emit("presentationCarte", dataToSend);
      
      console.log("📺 Event 'presentationCarte' émis à tous les clients");
    }
  });

  socket.on("changerMain", ()=>{
    const j = salon.joueurs[socket.id];
    if(!j || salon.phase!=="jeu" || !j.peutJouer) return;

    // Retirer les anciennes cartes de la circulation
    j.main.forEach(carte => {
      const index = salon.cartesEnCirculation.indexOf(carte);
      if(index > -1) salon.cartesEnCirculation.splice(index, 1);
    });

    // Piocher une nouvelle main unique
    const nouvelleMain = piocherCartes(7, []);
    j.main = nouvelleMain;
    
    // Mettre à jour la circulation
    salon.cartesEnCirculation = getCartesEnJeu();
    
    socket.emit("main", j.main);
    io.emit("chatMessage", 🔄 ${j.pseudo} a changé sa main);
    console.log(🔄 ${j.pseudo} a changé sa main (Circulation: ${salon.cartesEnCirculation.length}));
  });

  socket.on("carteSuivante", ()=>{
    if(salon.phase !== "presentation") return;
    
    // Ajouter le joueur à la liste s'il n'y est pas déjà
    if(!salon.joueursPresCarteActuelle.includes(socket.id)){
      salon.joueursPresCarteActuelle.push(socket.id);
      console.log(👆 ${salon.joueurs[socket.id]?.pseudo} a cliqué sur suivant (${salon.joueursPresCarteActuelle.length}/${Object.keys(salon.joueurs).length}));
    }
    
    const totalJoueurs = Object.keys(salon.joueurs).length;
    const joueursQuiOntClique = salon.joueursPresCarteActuelle.length;
    
    // Informer tous les joueurs du nombre de clics
    io.emit("updateClicsSuivant", {
      joueursQuiOntClique,
      totalJoueurs
    });
    
    // Vérifier si tout le monde a cliqué
    if(salon.joueursPresCarteActuelle.length >= totalJoueurs){
      // Reset pour la prochaine carte
      salon.joueursPresCarteActuelle = [];
      salon.carteActuelle++;
      
      if(salon.carteActuelle >= salon.cartesPosees.length){
        // Toutes les cartes ont été présentées, passer au vote
        salon.phase = "vote";
        const cartesTexte = salon.cartesPosees.map(c => c.carte);
        console.log("📤 Envoi cartes pour vote:", cartesTexte);
        io.emit("phaseVote", cartesTexte);
        console.log("🗳️  Phase de vote commencée");
      } else {
        // Envoyer la carte suivante
        const dataToSend = {
          carte: salon.cartesPosees[salon.carteActuelle].carte,
          index: salon.carteActuelle,
          total: salon.cartesPosees.length,
          question: salon.questionActuelle,
          joueursQuiOntClique: 0,
          totalJoueurs: totalJoueurs
        };
        io.emit("presentationCarte", dataToSend);
        console.log(📺 Carte ${salon.carteActuelle + 1}/${salon.cartesPosees.length} envoyée);
      }
    }
  });

  socket.on("voter", index=>{
    if(salon.phase !== "vote") return;
    const j = salon.joueurs[socket.id];
    if(!j || j.vote !== null) return;
    if(index < 0 || index >= salon.cartesPosees.length) return;

    salon.cartesPosees[index].votes += 1;
    j.vote = index;

    console.log(✅ ${j.pseudo} a voté pour la carte ${index});

    // Vérifier si tout le monde a voté (uniquement ceux qui ont posé une carte)
    const joueursQuiOntJoue = Object.values(salon.joueurs).filter(joueur => 
      salon.cartesPosees.some(c => c.socketId === joueur.vote || c.socketId === Object.keys(salon.joueurs).find(id => salon.joueurs[id] === joueur))
    );
    
    // Plus simple: vérifier que tous les joueurs qui ont une main ont voté
    const joueursAvecMain = Object.values(salon.joueurs);
    const nbVotes = joueursAvecMain.filter(joueur => joueur.vote !== null).length;
    const tousOntVote = nbVotes === joueursAvecMain.length;
    
    console.log(📊 Votes: ${nbVotes}/${joueursAvecMain.length});
    
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
      io.emit("chatMessage", 🏆 ${nomsGagnants} ${gagnants.length > 1 ? 'ont gagné' : 'a gagné'} ce tour !);

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
    if(pseudo) io.emit("chatMessage", 🔴 ${pseudo} a quitté la partie);
    io.emit("etatSalon", salon);
    
    if(Object.keys(salon.joueurs).length < 2){
      salon.partieEnCours = false;
    }
  });

  socket.on("disconnect", ()=>{
    const pseudo = salon.joueurs[socket.id]?.pseudo;
    delete salon.joueurs[socket.id];
    if(pseudo) io.emit("chatMessage", 🔴 ${pseudo} s'est déconnecté);
    io.emit("etatSalon", salon);
    
    if(Object.keys(salon.joueurs).length < 2){
      salon.partieEnCours = false;
    }
  });

  socket.on("chatMessage", msg=>{
    const j = salon.joueurs[socket.id];
    if(j && msg.trim() !== ""){
      io.emit("chatMessage", ${j.pseudo}: ${msg.trim()});
    }
  });
});

// --- Démarrage serveur ---
nouvelleQuestion();
server.listen(3000, ()=>console.log("🚀 Serveur sur http://localhost:3000"));




app.get("/kukipix", async (req, res) => {
  try {
    const key = JSON.parse(process.env.GOOGLE_DRIVE_KEY);

    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"]
    });

    const drive = google.drive({ version: "v3", auth });

    const folderId = process.env.DRIVE_FOLDER_ID;

    const response = await drive.files.list({
      q: '${folderId}' in parents and mimeType contains 'image/',
      fields: "files(id, name, mimeType)",
    });

    res.json({
      success: true,
      count: response.data.files.length,
      files: response.data.files
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.get("/kukipix", async (req, res) => {
  try {
    console.log("✅ /kukipix appelé");

    console.log("API KEY =", process.env.GOOGLE_API_KEY);
    console.log("FOLDER ID =", process.env.KUKIPIX_FOLDER_ID);

    res.json({
      success: true,
      test: "route OK",
      apiKeyDefined: !!process.env.GOOGLE_API_KEY,
      folderIdDefined: !!process.env.KUKIPIX_FOLDER_ID
    });

  } catch (err) {
    console.error("❌ ERREUR /kukipix :", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
