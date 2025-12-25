// =====================
// IMPORTS
// =====================
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const bodyParser = require("body-parser");
const { google } = require("googleapis");

// =====================
// INIT SERVEUR
// =====================
const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use(bodyParser.json());

// =====================
// CHARGEMENT DES FICHIERS
// =====================
let cartes = fs.readFileSync("cartes.txt", "utf8")
  .split("\n").map(l => l.trim()).filter(l => l.length > 0);

let questions = fs.readFileSync("textequestion.txt", "utf8")
  .split("\n").map(l => l.trim()).filter(l => l.length > 0);

console.log(`📦 ${cartes.length} cartes et ${questions.length} questions chargées.`);

// =====================
// AJOUT CARTES / QUESTIONS
// =====================
app.post("/ajouterCarte", (req, res) => {
  const { type, texte } = req.body;

  if (!texte || !type || !["carte", "question"].includes(type)) {
    return res.status(400).send("Mauvais format");
  }

  if (type === "carte") {
    fs.appendFileSync("cartes.txt", "\n" + texte);
    cartes.push(texte);
  } else {
    fs.appendFileSync("textequestion.txt", "\n" + texte);
    questions.push(texte);
  }

  res.json({ success: true });
});

// =====================
// ÉTAT DU SALON
// =====================
const salon = {
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

// =====================
// FONCTIONS UTILES
// =====================
function piocherCartes(nb) {
  let pile = cartes.filter(c => !salon.cartesEnCirculation.includes(c));

  if (pile.length < nb) {
    pile = [...cartes];
    salon.cartesEnCirculation = [];
  }

  pile.sort(() => Math.random() - 0.5);

  const tirage = pile.slice(0, nb);
  salon.cartesEnCirculation.push(...tirage);
  return tirage;
}

function nouvelleQuestion() {
  let dispo = questions.filter(q => !salon.questionsUtilisees.includes(q));

  if (dispo.length === 0) {
    salon.questionsUtilisees = [];
    dispo = [...questions];
  }

  salon.questionActuelle = dispo[Math.floor(Math.random() * dispo.length)];
  salon.questionsUtilisees.push(salon.questionActuelle);
}

// =====================
// DÉMARRER PARTIE
// =====================
function demarrerPartie() {
  salon.partieEnCours = true;
  salon.phase = "jeu";
  salon.cartesPosees = [];
  salon.cartesEnCirculation = [];

  Object.values(salon.joueurs).forEach(j => {
    j.main = piocherCartes(7);
    j.peutJouer = true;
    j.vote = null;
  });

  nouvelleQuestion();
  io.emit("question", salon.questionActuelle);
  io.emit("etatSalon", salon);

  Object.entries(salon.joueurs).forEach(([id, j]) => {
    io.to(id).emit("main", j.main);
  });

  console.log("🎮 Partie démarrée");
}

// =====================
// SOCKET.IO
// =====================
io.on("connection", socket => {
  console.log("🟢 Connexion", socket.id);

  socket.on("rejoindreSalon", pseudo => {
    if (!pseudo) return;

    salon.joueurs[socket.id] = {
      pseudo,
      main: [],
      peutJouer: true,
      points: 0,
      vote: null
    };

    io.emit("etatSalon", salon);
    io.emit("chatMessage", `🟢 ${pseudo} a rejoint`);

    if (!salon.partieEnCours && Object.keys(salon.joueurs).length >= 2) {
      demarrerPartie();
    }
  });

  socket.on("poserCarteIndex", index => {
    const j = salon.joueurs[socket.id];
    if (!j || !j.peutJouer || salon.phase !== "jeu") return;

    const carte = j.main.splice(index, 1)[0];
    salon.cartesPosees.push({ carte, socketId: socket.id, pseudo: j.pseudo, votes: 0 });
    j.peutJouer = false;

    socket.emit("main", j.main);
    io.emit("nombreCartesAttente", salon.cartesPosees.length);

    const tousOntJoue = Object.values(salon.joueurs).every(j => !j.peutJouer);

    if (tousOntJoue && salon.cartesPosees.length >= 2) {
      salon.phase = "presentation";
      salon.cartesPosees.sort(() => Math.random() - 0.5);

      io.emit("presentationCarte", {
        carte: salon.cartesPosees[0].carte,
        index: 0,
        total: salon.cartesPosees.length,
        question: salon.questionActuelle
      });
    }
  });

  socket.on("disconnect", () => {
    const pseudo = salon.joueurs[socket.id]?.pseudo;
    delete salon.joueurs[socket.id];
    io.emit("etatSalon", salon);
    if (pseudo) io.emit("chatMessage", `🔴 ${pseudo} est parti`);
  });
});

// =====================
// KUKIPIX — GOOGLE DRIVE
// =====================
app.get("/kukipix", async (req, res) => {
  try {
    console.log("📸 /kukipix appelé");

    if (!process.env.GOOGLE_DRIVE_KEY) {
      throw new Error("GOOGLE_DRIVE_KEY manquant");
    }
    if (!process.env.DRIVE_FOLDER_ID) {
      throw new Error("DRIVE_FOLDER_ID manquant");
    }

    const credentials = JSON.parse(process.env.GOOGLE_DRIVE_KEY);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"]
    });

    const drive = google.drive({ version: "v3", auth });

    const result = await drive.files.list({
      q: `'${process.env.DRIVE_FOLDER_ID}' in parents and mimeType contains 'image/'`,
      fields: "files(id,name,mimeType)"
    });

    res.json({
      success: true,
      files: result.data.files
    });

  } catch (err) {
    console.error("❌ Kukipix erreur:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// =====================
// LANCEMENT SERVEUR
// =====================
nouvelleQuestion();

server.listen(3000, () => {
  console.log("🚀 Serveur lancé sur http://localhost:3000");
});
