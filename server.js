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
  imagesList: [],
  motsCles: [], // Liste des mots-clés de l'image actuelle
  motsTrouves: [], // Mots-clés déjà trouvés avec {mot, joueurId, points}
  resolutionActuelle: 25 // 25, 50 ou "original"
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
  const cache = size === 25 ? imageCache.low : size === 50 ? imageCache.medium : imageCache.high;
  
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

  const imagesDisponibles = salonKukipix.imagesList.filter(img => 
    !salonKukipix.imagesUtilisees.includes(img.id)
  );

  if (imagesDisponibles.length === 0) {
    console.log('🏁 Kukipix: Toutes les images ont été jouées !');
    io.to('kukipix').emit("toutesImagesJouees");
    salonKukipix.phase = "fini";
    return;
  }

  const randomImage = imagesDisponibles[Math.floor(Math.random() * imagesDisponibles.length)];
  salonKukipix.imageActuelle = randomImage;
  salonKukipix.imagesUtilisees.push(randomImage.id);
  salonKukipix.phase = "jeu";
  salonKukipix.tempsDebut = Date.now();
  salonKukipix.resolutionActuelle = 25;
  
  const nomSansExtension = randomImage.name.replace(/\.[^/.]+$/, "");
  salonKukipix.motsCles = nomSansExtension.split(',').map(m => m.trim().toLowerCase()).filter(m => m.length > 0);
  salonKukipix.motsTrouves = [];
  salonKukipix.reponseCorrecte = nomSansExtension;

  console.log(`🎮 Kukipix: Partie ${salonKukipix.imagesUtilisees.length}/${salonKukipix.imagesList.length} - ${salonKukipix.motsCles.length} mots-clés:`, salonKukipix.motsCles);

  Object.values(salonKukipix.joueurs).forEach(j => {
    j.pointsPartie = 0;
  });

  io.to('kukipix').emit("nouvellePartie", {
    totalJoueurs: Object.keys(salonKukipix.joueurs).length,
    totalMotsCles: salonKukipix.motsCles.length,
    partieNum: salonKukipix.imagesUtilisees.length,
    totalImages: salonKukipix.imagesList.length
  });

  const image25 = await getCompressedImage(randomImage.id, 25);
  if (image25) {
    io.to('kukipix').emit("imageUpdate", { image: image25, size: "25px" });
  }

  // Après 15 secondes, envoyer l'image 50px
  setTimeout(async () => {
    if (salonKukipix.phase === "jeu" && salonKukipix.imageActuelle?.id === randomImage.id) {
      salonKukipix.resolutionActuelle = 50;
      const image50 = await getCompressedImage(randomImage.id, 50);
      if (image50) {
        io.to('kukipix').emit("imageUpdate", { image: image50, size: "50px" });
      }
    }
  }, 15000);

  // Après 30 secondes, envoyer l'image originale
  setTimeout(async () => {
    if (salonKukipix.phase === "jeu" && salonKukipix.imageActuelle?.id === randomImage.id) {
      salonKukipix.resolutionActuelle = "original";
      const imageOriginal = await getCompressedImage(randomImage.id, 'original');
      if (imageOriginal) {
        io.to('kukipix').emit("imageUpdate", { image: imageOriginal, size: "original" });
      }
    }
  }, 30000);

  // Après 40 secondes (30s + 10s), fin de manche automatique
  setTimeout(async () => {
    if (salonKukipix.phase === "jeu" && salonKukipix.imageActuelle?.id === randomImage.id) {
      terminerManche();
    }
  }, 40000);
}

function terminerManche() {
  if (salonKukipix.phase !== "jeu") return;
  
  salonKukipix.phase = "resultat";
  
  console.log('⏱️  Fin de manche (temps écoulé)');
  
  io.to('kukipix').emit("finPartie", {
    reponse: salonKukipix.reponseCorrecte,
    motsTrouves: salonKukipix.motsTrouves,
    motsClesNonTrouves: salonKukipix.motsCles.filter(mot => 
      !salonKukipix.motsTrouves.some(m => m.mot === mot)
    ),
    classement: Object.values(salonKukipix.joueurs).sort((a, b) => b.points - a.points)
  });
  
  // Lancer automatiquement la prochaine partie après 5 secondes
  setTimeout(async () => {
    await nouvellePartieKukipix();
  }, 5000);
}

function verifierReponse(reponse, joueurId) {
  const reponseNormalisee = reponse.toLowerCase().trim();
  
  // Vérifier si le mot-clé existe dans la liste
  const motTrouve = salonKukipix.motsCles.find(mot => 
    mot === reponseNormalisee || 
    mot.includes(reponseNormalisee) || 
    reponseNormalisee.includes(mot)
  );
  
  if (!motTrouve) return { trouve: false };
  
  // Vérifier si le mot n'a pas déjà été trouvé
  const dejaUtilise = salonKukipix.motsTrouves.find(m => m.mot === motTrouve);
  if (dejaUtilise) {
    return { trouve: false, dejaUtilise: true, parQui: dejaUtilise.joueurPseudo };
  }
  
  // Calculer les points selon la résolution
  let points = 0;
  if (salonKukipix.resolutionActuelle === 25) points = 2;
  else if (salonKukipix.resolutionActuelle === 50) points = 1;
  else points = 0; // Pas de points pour l'original
  
  return { trouve: true, mot: motTrouve, points };
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
      pointsPartie: 0
    };

    io.to('kukipix').emit("etatSalon", salonKukipix);
    io.to('kukipix').emit("chatMessage", `🟢 ${pseudo} a rejoint`);

    if (salonKukipix.phase === "jeu" && salonKukipix.imageActuelle) {
      const tempsEcoule = Date.now() - salonKukipix.tempsDebut;
      
      if (tempsEcoule < 30000) {
        getCompressedImage(salonKukipix.imageActuelle.id, 25).then(img => {
          if (img) socket.emit("imageUpdate", { image: img, size: "25px" });
        });
      } else if (tempsEcoule < 60000) {
        getCompressedImage(salonKukipix.imageActuelle.id, 50).then(img => {
          if (img) socket.emit("imageUpdate", { image: img, size: "50px" });
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
    
    // Réinitialiser les images utilisées si on démarre une nouvelle session
    if(salonKukipix.phase === "attente" || salonKukipix.phase === "fini") {
      salonKukipix.imagesUtilisees = [];
      console.log("🔄 Kukipix: Réinitialisation des images utilisées");
    }
    
    await nouvellePartieKukipix();
  });

  socket.on("proposerReponse", reponse => {
    const j = salonKukipix.joueurs[socket.id];
    if (!j || salonKukipix.phase !== "jeu") return;

    const resultat = verifierReponse(reponse, socket.id);

    if (resultat.trouve) {
      salonKukipix.motsTrouves.push({
        mot: resultat.mot,
        joueurId: socket.id,
        joueurPseudo: j.pseudo,
        points: resultat.points
      });
      
      j.points += resultat.points;
      j.pointsPartie = (j.pointsPartie || 0) + resultat.points;

      io.to('kukipix').emit("motTrouve", {
        mot: resultat.mot,
        joueur: j.pseudo,
        points: resultat.points,
        totalTrouves: salonKukipix.motsTrouves.length,
        totalMotsCles: salonKukipix.motsCles.length
      });

      io.to('kukipix').emit("chatMessage", `✅ ${j.pseudo} a trouvé "${resultat.mot}" ! (+${resultat.points} pts)`);
      io.to('kukipix').emit("etatSalon", salonKukipix);

      // Si tous les mots-clés sont trouvés, dépixeliser et terminer
      if (salonKukipix.motsTrouves.length >= salonKukipix.motsCles.length) {
        salonKukipix.resolutionActuelle = "original";
        getCompressedImage(salonKukipix.imageActuelle.id, 'original').then(imageOriginal => {
          if (imageOriginal) {
            io.to('kukipix').emit("imageUpdate", { image: imageOriginal, size: "original" });
            io.to('kukipix').emit("chatMessage", "🎉 Tous les mots-clés trouvés ! Image révélée !");
          }
        });
        
        // Terminer la manche après 10 secondes
        setTimeout(() => {
          terminerManche();
        }, 10000);
      }
    } else if (resultat.dejaUtilise) {
      socket.emit("chatMessage", `⚠️ "${reponse}" a déjà été trouvé par ${resultat.parQui} !`);
    } else {
      socket.emit("chatMessage", "❌ Ce n'est pas un mot-clé !");
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