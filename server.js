const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const sharp = require("sharp");

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use(bodyParser.json());

// ============================================
// BLANC MANGÉ COCO
// ============================================

// Chargement cartes et questions BMC
let cartes = fs.readFileSync("cartes.txt", "utf8")
  .split("\n").map(l => l.trim()).filter(l => l.length>0);
let questions = fs.readFileSync("textequestion.txt","utf8")
  .split("\n").map(l => l.trim()).filter(l => l.length>0);

console.log(`📦 BMC: ${cartes.length} cartes et ${questions.length} questions chargées.`);

// Endpoint ajout carte/question BMC
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

// Salon Blanc Mangé Coco
const salonBMC = {
  joueurs: {},
  cartesPosees: [],
  phase: "jeu",
  questionActuelle: null,
  changementCarteVotes: [],
  partieEnCours: false,
  carteActuelle: 0,
  joueursPresCarteActuelle: [],
  questionsUtilisees: [],
  cartesEnCirculation: []
};

// Fonctions BMC
function piocherCartes(nbCartes, cartesAExclure = []){
  let pile = [...cartes];
  const toutesCartesAExclure = [...cartesAExclure, ...salonBMC.cartesEnCirculation];
  pile = pile.filter(c => !toutesCartesAExclure.includes(c));
  
  if(pile.length < nbCartes){
    console.log("⚠️  BMC: Pas assez de cartes uniques, réinitialisation...");
    pile = [...cartes];
    pile = pile.filter(c => !salonBMC.cartesEnCirculation.includes(c));
  }
  
  pile.sort(() => Math.random() - 0.5);
  
  const main = [];
  for(let i = 0; i < nbCartes && pile.length > 0; i++){
    const carte = pile.shift();
    main.push(carte);
    if(!salonBMC.cartesEnCirculation.includes(carte)){
      salonBMC.cartesEnCirculation.push(carte);
    }
  }
  return main;
}

function getCartesEnJeu(){
  const cartesEnJeu = [];
  Object.values(salonBMC.joueurs).forEach(j => {
    cartesEnJeu.push(...j.main);
  });
  return cartesEnJeu;
}

function nouvelleQuestion(){ 
  let questionsDisponibles = questions.filter(q => !salonBMC.questionsUtilisees.includes(q));
  
  if(questionsDisponibles.length === 0){
    console.log("🔄 BMC: Toutes les questions utilisées, réinitialisation !");
    salonBMC.questionsUtilisees = [];
    questionsDisponibles = [...questions];
  }
  
  salonBMC.questionActuelle = questionsDisponibles[Math.floor(Math.random() * questionsDisponibles.length)];
  salonBMC.questionsUtilisees.push(salonBMC.questionActuelle);
  
  console.log(`📋 BMC: Question ${salonBMC.questionsUtilisees.length}/${questions.length}`);
}

function demarrerPartieBMC(){
  if(Object.keys(salonBMC.joueurs).length < 2) return;
  
  salonBMC.partieEnCours = true;
  salonBMC.cartesPosees = [];
  salonBMC.phase = "jeu";
  salonBMC.changementCarteVotes = [];
  salonBMC.cartesEnCirculation = [];
  
  Object.entries(salonBMC.joueurs).forEach(([id,j])=>{
    j.main = piocherCartes(7, []);
    j.peutJouer = true;
    j.vote = null;
  });
  
  nouvelleQuestion();
  io.to('bmc').emit("etatSalon", salonBMC);
  io.to('bmc').emit("question", salonBMC.questionActuelle);
  Object.entries(salonBMC.joueurs).forEach(([id,j])=> {
    io.to(id).emit("main", j.main);
  });
  
  console.log("🎮 BMC: Partie démarrée");
}

function nouveauTourBMC(){
  salonBMC.cartesPosees = [];
  salonBMC.phase = "jeu";
  salonBMC.changementCarteVotes = [];
  salonBMC.carteActuelle = 0;
  salonBMC.joueursPresCarteActuelle = [];
  
  salonBMC.cartesEnCirculation = getCartesEnJeu();
  
  Object.entries(salonBMC.joueurs).forEach(([id,j])=>{
    const nouvellesCarte = piocherCartes(1, []);
    j.main.push(...nouvellesCarte);
    j.peutJouer = true;
    j.vote = null;
  });
  
  salonBMC.cartesEnCirculation = getCartesEnJeu();
  nouvelleQuestion();
  
  io.to('bmc').emit("etatSalon", salonBMC);
  io.to('bmc').emit("question", salonBMC.questionActuelle);
  
  Object.entries(salonBMC.joueurs).forEach(([id,j])=> {
    io.to(id).emit("main", j.main);
  });
}

// ============================================
// KUKIPIX
// ============================================

// Configuration Google Drive
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  scopes: SCOPES,
});

const drive = google.drive({ version: 'v3', auth });
const FOLDER_ID = process.env.KUKIPIX_FOLDER_ID;

// Cache des images compressées
const imageCache = {
  low: new Map(),
  medium: new Map(),
  high: new Map()
};

// Salon Kukipix
const salonKukipix = {
  joueurs: {},
  imageActuelle: null,
  phase: "attente",
  imageData: null,
  tempsDebut: null,
  reponseCorrecte: null,
  imagesList: []
};

async function listImagesFromDrive() {
  try {
    console.log('📂 Kukipix: Récupération des images depuis Google Drive...');
    const response = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and (mimeType='image/jpeg' or mimeType='image/png' or mimeType='image/jpg')`,
      fields: 'files(id, name, mimeType)',
      pageSize: 100
    });

    salonKukipix.imagesList = response.data.files || [];
    console.log(`✅ Kukipix: ${salonKukipix.imagesList.length} images trouvées`);
    return salonKukipix.imagesList;
  } catch (error) {
    console.error('❌ Kukipix: Erreur récupération images:', error.message);
    return [];
  }
}

async function getCompressedImage(fileId, size) {
  const cacheKey = `${fileId}_${size}`;
  const cache = size === 18 ? imageCache.low : size === 40 ? imageCache.medium : imageCache.high;
  
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  try {
    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    const chunks = [];
    for await (const chunk of response.data) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    let processedBuffer;

    if (size === 'original') {
      processedBuffer = buffer;
    } else {
      processedBuffer = await sharp(buffer)
        .resize(size, size, { fit: 'inside' })
        .jpeg({ quality: 80 })
        .toBuffer();
    }

    const base64 = processedBuffer.toString('base64');
    const dataUrl = `data:image/jpeg;base64,${base64}`;

    cache.set(cacheKey, dataUrl);
    return dataUrl;
  } catch (error) {
    console.error(`❌ Kukipix: Erreur compression ${size}px:`, error.message);
    return null;
  }
}

async function nouvellePartieKukipix() {
  if (salonKukipix.imagesList.length === 0) {
    await listImagesFromDrive();
  }

  if (salonKukipix.imagesList.length === 0) {
    console.log('❌ Kukipix: Aucune image disponible');
    return;
  }

  const randomImage = salonKukipix.imagesList[Math.floor(Math.random() * salonKukipix.imagesList.length)];
  salonKukipix.imageActuelle = randomImage;
  salonKukipix.phase = "jeu";
  salonKukipix.tempsDebut = Date.now();
  salonKukipix.reponseCorrecte = randomImage.name.replace(/\.[^/.]+$/, "");

  console.log(`🎮 Kukipix: Nouvelle partie - ${salonKukipix.reponseCorrecte}`);

  Object.values(salonKukipix.joueurs).forEach(j => {
    j.aTrouve = false;
    j.tempsReponse = null;
  });

  io.to('kukipix').emit("nouvellePartie", {
    totalJoueurs: Object.keys(salonKukipix.joueurs).length
  });

  const image18 = await getCompressedImage(randomImage.id, 25);
  if (image18) {
    io.to('kukipix').emit("imageUpdate", { image: image18, size: "25px" });
  }

  setTimeout(async () => {
    if (salonKukipix.phase === "jeu" && salonKukipix.imageActuelle?.id === randomImage.id) {
      const image40 = await getCompressedImage(randomImage.id, 50);
      if (image40) {
        io.to('kukipix').emit("imageUpdate", { image: image40, size: "50px" });
      }
    }
  }, 30000);

  setTimeout(async () => {
    if (salonKukipix.phase === "jeu" && salonKukipix.imageActuelle?.id === randomImage.id) {
      const imageOriginal = await getCompressedImage(randomImage.id, 'original');
      if (imageOriginal) {
        io.to('kukipix').emit("imageUpdate", { image: imageOriginal, size: "original" });
      }
    }
  }, 60000);
}

function verifierReponse(reponse) {
  const reponseNormalisee = reponse.toLowerCase().trim();
  const correcteNormalisee = salonKukipix.reponseCorrecte.toLowerCase().trim();
  
  return reponseNormalisee === correcteNormalisee || 
         correcteNormalisee.includes(reponseNormalisee) ||
         reponseNormalisee.includes(correcteNormalisee);
}

// Initialiser
nouvelleQuestion();
listImagesFromDrive();

// ============================================
// SOCKET.IO - GESTION DES CONNEXIONS
// ============================================

io.on("connection", socket => {
  console.log("🟢 Nouveau joueur:", socket.id);
  
  let currentGame = null;

  // Rejoindre un jeu spécifique
  socket.on("joinGame", (game) => {
    currentGame = game;
    socket.join(game);
    console.log(`✅ ${socket.id} rejoint ${game}`);
  });

  // ========== BLANC MANGÉ COCO ==========
  socket.on("rejoindreSalon", pseudo => {
    if(!pseudo) return;
    socket.join('bmc');
    currentGame = 'bmc';
    
    const estNouveauJoueur = !salonBMC.joueurs[socket.id];
    
    if(estNouveauJoueur){
      salonBMC.joueurs[socket.id] = { 
        pseudo, 
        main: [], 
        peutJouer: true, 
        points: 0,
        vote: null 
      };
      
      io.to('bmc').emit("chatMessage", `🟢 ${pseudo} a rejoint la partie`);
      
      if(salonBMC.partieEnCours){
        salonBMC.joueurs[socket.id].main = piocherCartes(7, []);
        salonBMC.cartesEnCirculation = getCartesEnJeu();
        socket.emit("main", salonBMC.joueurs[socket.id].main);
        socket.emit("question", salonBMC.questionActuelle);
        
        if(salonBMC.phase === "presentation"){
          socket.emit("presentationCarte", {
            carte: salonBMC.cartesPosees[salonBMC.carteActuelle].carte,
            index: salonBMC.carteActuelle,
            total: salonBMC.cartesPosees.length,
            question: salonBMC.questionActuelle,
            joueursQuiOntClique: salonBMC.joueursPresCarteActuelle.length,
            totalJoueurs: Object.keys(salonBMC.joueurs).length
          });
        } else if(salonBMC.phase === "vote"){
          socket.emit("phaseVote", salonBMC.cartesPosees.map(c => c.carte));
        } else if(salonBMC.phase === "jeu"){
          socket.emit("nombreCartesAttente", salonBMC.cartesPosees.length);
        }
      }
    }
    
    io.to('bmc').emit("etatSalon", salonBMC);
    
    if(!salonBMC.partieEnCours && Object.keys(salonBMC.joueurs).length >= 2){
      demarrerPartieBMC();
    }
  });

  socket.on("poserCarteIndex", index => {
    const j = salonBMC.joueurs[socket.id];
    if(!j || !j.peutJouer || salonBMC.phase!=="jeu") return;
    if(index<0 || index>=j.main.length) return;

    const carte = j.main.splice(index,1)[0];
    const circIndex = salonBMC.cartesEnCirculation.indexOf(carte);
    if(circIndex > -1) salonBMC.cartesEnCirculation.splice(circIndex, 1);
    
    j.peutJouer = false;
    salonBMC.cartesPosees.push({
      carte, 
      socketId: socket.id, 
      pseudo: j.pseudo,
      votes: 0
    });

    socket.emit("main", j.main);
    io.to('bmc').emit("nombreCartesAttente", salonBMC.cartesPosees.length);

    const tousLesJoueurs = Object.values(salonBMC.joueurs);
    const tousOntJoue = tousLesJoueurs.every(joueur => !joueur.peutJouer);
    
    if(tousOntJoue && salonBMC.cartesPosees.length >= 2){
      salonBMC.phase = "presentation";
      salonBMC.carteActuelle = 0;
      salonBMC.joueursPresCarteActuelle = [];
      salonBMC.cartesPosees.sort(() => Math.random() - 0.5);
      
      const dataToSend = {
        carte: salonBMC.cartesPosees[0].carte,
        index: 0,
        total: salonBMC.cartesPosees.length,
        question: salonBMC.questionActuelle,
        joueursQuiOntClique: 0,
        totalJoueurs: Object.keys(salonBMC.joueurs).length
      };
      
      io.to('bmc').emit("presentationCarte", dataToSend);
    }
  });

  socket.on("carteSuivante", () => {
    if(salonBMC.phase !== "presentation") return;
    
    if(!salonBMC.joueursPresCarteActuelle.includes(socket.id)){
      salonBMC.joueursPresCarteActuelle.push(socket.id);
    }
    
    const totalJoueurs = Object.keys(salonBMC.joueurs).length;
    const joueursQuiOntClique = salonBMC.joueursPresCarteActuelle.length;
    
    io.to('bmc').emit("updateClicsSuivant", {
      joueursQuiOntClique,
      totalJoueurs
    });
    
    if(salonBMC.joueursPresCarteActuelle.length >= totalJoueurs){
      salonBMC.joueursPresCarteActuelle = [];
      salonBMC.carteActuelle++;
      
      if(salonBMC.carteActuelle >= salonBMC.cartesPosees.length){
        salonBMC.phase = "vote";
        const cartesTexte = salonBMC.cartesPosees.map(c => c.carte);
        io.to('bmc').emit("phaseVote", cartesTexte);
      } else {
        const dataToSend = {
          carte: salonBMC.cartesPosees[salonBMC.carteActuelle].carte,
          index: salonBMC.carteActuelle,
          total: salonBMC.cartesPosees.length,
          question: salonBMC.questionActuelle,
          joueursQuiOntClique: 0,
          totalJoueurs: totalJoueurs
        };
        io.to('bmc').emit("presentationCarte", dataToSend);
      }
    }
  });

  socket.on("voter", index => {
    if(salonBMC.phase !== "vote") return;
    const j = salonBMC.joueurs[socket.id];
    if(!j || j.vote !== null) return;
    if(index < 0 || index >= salonBMC.cartesPosees.length) return;

    salonBMC.cartesPosees[index].votes += 1;
    j.vote = index;

    const joueursAvecMain = Object.values(salonBMC.joueurs);
    const nbVotes = joueursAvecMain.filter(joueur => joueur.vote !== null).length;
    const tousOntVote = nbVotes === joueursAvecMain.length;
    
    if(tousOntVote){
      salonBMC.phase = "resultat";
      
      let maxVotes = Math.max(...salonBMC.cartesPosees.map(c => c.votes));
      let gagnants = salonBMC.cartesPosees.filter(c => c.votes === maxVotes);
      
      gagnants.forEach(c => {
        if(salonBMC.joueurs[c.socketId]){
          salonBMC.joueurs[c.socketId].points += 1;
        }
      });

      const gagnantsData = gagnants.map(c => ({
        socketId: c.socketId,
        pseudo: c.pseudo,
        carte: c.carte,
        votes: c.votes
      }));

      io.to('bmc').emit("resultatVote", {
        gagnants: gagnantsData,
        cartesPosees: salonBMC.cartesPosees
      });
      io.to('bmc').emit("etatSalon", salonBMC);

      const nomsGagnants = gagnantsData.map(g => g.pseudo).join(", ");
      io.to('bmc').emit("chatMessage", `🏆 ${nomsGagnants} ${gagnants.length > 1 ? 'ont gagné' : 'a gagné'} ce tour !`);

      setTimeout(() => {
        nouveauTourBMC();
        io.to('bmc').emit("nouveauTour", { salon: salonBMC });
      }, 3000);
    }
  });

  socket.on("changerMain", () => {
    const j = salonBMC.joueurs[socket.id];
    if(!j || salonBMC.phase!=="jeu" || !j.peutJouer) return;

    j.main.forEach(carte => {
      const index = salonBMC.cartesEnCirculation.indexOf(carte);
      if(index > -1) salonBMC.cartesEnCirculation.splice(index, 1);
    });

    const nouvelleMain = piocherCartes(7, []);
    j.main = nouvelleMain;
    salonBMC.cartesEnCirculation = getCartesEnJeu();
    
    socket.emit("main", j.main);
    io.to('bmc').emit("chatMessage", `🔄 ${j.pseudo} a changé sa main`);
  });

  socket.on("changerQuestion", () => {
    if(salonBMC.changementCarteVotes.includes(socket.id)) return;
    salonBMC.changementCarteVotes.push(socket.id);

    const nbJoueurs = Object.keys(salonBMC.joueurs).length;
    if(salonBMC.changementCarteVotes.length > nbJoueurs / 2){
      nouvelleQuestion();
      salonBMC.changementCarteVotes = [];
      io.to('bmc').emit("question", salonBMC.questionActuelle);
      io.to('bmc').emit("chatMessage", "🔄 Question changée !");
    }
  });

  // ========== KUKIPIX ==========
  socket.on("rejoindreSalonKukipix", pseudo => {
    if (!pseudo) return;
    socket.join('kukipix');
    currentGame = 'kukipix';

    salonKukipix.joueurs[socket.id] = {
      pseudo,
      points: 0,
      aTrouve: false,
      tempsReponse: null
    };

    io.to('kukipix').emit("etatSalon", salonKukipix);
    io.to('kukipix').emit("chatMessage", `🟢 ${pseudo} a rejoint`);

    if (salonKukipix.phase === "jeu" && salonKukipix.imageActuelle) {
      const tempsEcoule = Date.now() - salonKukipix.tempsDebut;
      
      if (tempsEcoule < 30000) {
        getCompressedImage(salonKukipix.imageActuelle.id, 18).then(img => {
          if (img) socket.emit("imageUpdate", { image: img, size: "18px" });
        });
      } else if (tempsEcoule < 60000) {
        getCompressedImage(salonKukipix.imageActuelle.id, 40).then(img => {
          if (img) socket.emit("imageUpdate", { image: img, size: "40px" });
        });
      } else {
        getCompressedImage(salonKukipix.imageActuelle.id, 'original').then(img => {
          if (img) socket.emit("imageUpdate", { image: img, size: "original" });
        });
      }
    }
  });

  socket.on("demarrerPartie", async () => {
    if (salonKukipix.phase === "jeu") {
      socket.emit("chatMessage", "⚠️ Une partie est déjà en cours");
      return;
    }
    await nouvellePartieKukipix();
  });

  socket.on("proposerReponse", reponse => {
    const j = salonKukipix.joueurs[socket.id];
    if (!j || salonKukipix.phase !== "jeu" || j.aTrouve) return;

    const estCorrecte = verifierReponse(reponse);

    if (estCorrecte) {
      j.aTrouve = true;
      j.tempsReponse = Date.now() - salonKukipix.tempsDebut;
      
      let points = 100;
      if (j.tempsReponse < 10000) points = 100;
      else if (j.tempsReponse < 30000) points = 75;
      else if (j.tempsReponse < 60000) points = 50;
      else points = 25;

      j.points += points;

      io.to('kukipix').emit("chatMessage", `✅ ${j.pseudo} a trouvé ! (+${points} pts)`);
      io.to('kukipix').emit("etatSalon", salonKukipix);

      const tousOntTrouve = Object.values(salonKukipix.joueurs).every(joueur => joueur.aTrouve);
      if (tousOntTrouve) {
        setTimeout(() => {
          salonKukipix.phase = "resultat";
          io.to('kukipix').emit("finPartie", {
            reponse: salonKukipix.reponseCorrecte,
            classement: Object.values(salonKukipix.joueurs).sort((a, b) => b.points - a.points)
          });
        }, 2000);
      }
    } else {
      socket.emit("chatMessage", "❌ Ce n'est pas ça !");
    }
  });

  socket.on("chatMessage", msg => {
    if(currentGame === 'bmc'){
      const j = salonBMC.joueurs[socket.id];
      if(j && msg.trim() !== "") {
        io.to('bmc').emit("chatMessage", `${j.pseudo}: ${msg.trim()}`);
      }
    } else if(currentGame === 'kukipix'){
      const j = salonKukipix.joueurs[socket.id];
      if (j && msg.trim() !== "") {
        io.to('kukipix').emit("chatMessage", `${j.pseudo}: ${msg.trim()}`);
      }
    }
  });

  socket.on("deconnexion", () => {
    if(currentGame === 'bmc'){
      const pseudo = salonBMC.joueurs[socket.id]?.pseudo;
      delete salonBMC.joueurs[socket.id];
      if(pseudo) io.to('bmc').emit("chatMessage", `🔴 ${pseudo} a quitté`);
      io.to('bmc').emit("etatSalon", salonBMC);
      
      if(Object.keys(salonBMC.joueurs).length < 2){
        salonBMC.partieEnCours = false;
      }
    } else if(currentGame === 'kukipix'){
      const pseudo = salonKukipix.joueurs[socket.id]?.pseudo;
      delete salonKukipix.joueurs[socket.id];
      if (pseudo) io.to('kukipix').emit("chatMessage", `🔴 ${pseudo} s'est déconnecté`);
      io.to('kukipix').emit("etatSalon", salonKukipix);
    }
  });

  socket.on("disconnect", () => {
    if(currentGame === 'bmc'){
      const pseudo = salonBMC.joueurs[socket.id]?.pseudo;
      delete salonBMC.joueurs[socket.id];
      if(pseudo) io.to('bmc').emit("chatMessage", `🔴 ${pseudo} s'est déconnecté`);
      io.to('bmc').emit("etatSalon", salonBMC);
      
      if(Object.keys(salonBMC.joueurs).length < 2){
        salonBMC.partieEnCours = false;
      }
    } else if(currentGame === 'kukipix'){
      const pseudo = salonKukipix.joueurs[socket.id]?.pseudo;
      delete salonKukipix.joueurs[socket.id];
      if(pseudo) io.to('kukipix').emit("chatMessage", `🔴 ${pseudo} s'est déconnecté`);
      io.to('kukipix').emit("etatSalon", salonKukipix);
    }
  });
});

server.listen(3000, () => console.log("🚀 Serveur multi-jeux sur http://localhost:3000"));