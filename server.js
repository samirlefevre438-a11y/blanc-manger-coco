/**************************************************
 * IMPORTS
 **************************************************/
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const bodyParser = require("body-parser");
const { google } = require("googleapis");

/**************************************************
 * INIT SERVEUR
 **************************************************/
const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use(bodyParser.json());

/**************************************************
 * CHARGEMENT DES CARTES / QUESTIONS
 **************************************************/
let cartes = fs.readFileSync("cartes.txt", "utf8")
  .split("\n")
  .map(l => l.trim())
  .filter(Boolean);

let questions = fs.readFileSync("textequestion.txt", "utf8")
  .split("\n")
  .map(l => l.trim())
  .filter(Boolean);

console.log(`${cartes.length} cartes et ${questions.length} questions chargees`);

/**************************************************
 * SALON
 **************************************************/
const salon = {
  joueurs: {},
  cartesPosees: [],
  phase: "jeu",
  questionActuelle: null,
  partieEnCours: false,
};

/**************************************************
 * OUTILS
 **************************************************/
function nouvelleQuestion() {
  salon.questionActuelle =
    questions[Math.floor(Math.random() * questions.length)];
}

function demarrerPartie() {
  if (Object.keys(salon.joueurs).length < 2) return;

  salon.partieEnCours = true;
  salon.cartesPosees = [];
  salon.phase = "jeu";

  Object.values(salon.joueurs).forEach(j => {
    j.main = [...cartes].sort(() => Math.random() - 0.5).slice(0, 7);
    j.peutJouer = true;
    j.vote = null;
  });

  nouvelleQuestion();

  io.emit("question", salon.questionActuelle);
  Object.entries(salon.joueurs).forEach(([id, j]) => {
    io.to(id).emit("main", j.main);
  });

  console.log("Partie demarree");
}

/**************************************************
 * SOCKET.IO
 **************************************************/
io.on("connection", socket => {
  console.log("Nouveau joueur", socket.id);

  socket.on("rejoindreSalon", pseudo => {
    if (!pseudo) return;

    salon.joueurs[socket.id] = {
      pseudo,
      main: [],
      points: 0,
      peutJouer: true,
      vote: null,
    };

    io.emit("etatSalon", salon);

    if (!salon.partieEnCours && Object.keys(salon.joueurs).length >= 2) {
      demarrerPartie();
    }
  });

  socket.on("poserCarteIndex", index => {
    const j = salon.joueurs[socket.id];
    if (!j || !j.peutJouer || salon.phase !== "jeu") return;

    const carte = j.main.splice(index, 1)[0];
    j.peutJouer = false;

    salon.cartesPosees.push({
      carte,
      socketId: socket.id,
      pseudo: j.pseudo,
      votes: 0,
    });

    socket.emit("main", j.main);

    const tousOntJoue = Object.values(salon.joueurs).every(
      p => !p.peutJouer
    );

    if (tousOntJoue) {
      salon.phase = "vote";
      io.emit("phaseVote", salon.cartesPosees.map(c => c.carte));
    }
  });

  socket.on("voter", index => {
    if (salon.phase !== "vote") return;
    const j = salon.joueurs[socket.id];
    if (!j || j.vote !== null) return;

    salon.cartesPosees[index].votes++;
    j.vote = index;

    const votes = Object.values(salon.joueurs).filter(j => j.vote !== null);
    if (votes.length === Object.keys(salon.joueurs).length) {
      salon.phase = "resultat";

      const gagnante = salon.cartesPosees.sort(
        (a, b) => b.votes - a.votes
      )[0];

      salon.joueurs[gagnante.socketId].points++;

      io.emit("resultatVote", gagnante);

      setTimeout(() => demarrerPartie(), 3000);
    }
  });

  socket.on("disconnect", () => {
    delete salon.joueurs[socket.id];
    io.emit("etatSalon", salon);

    if (Object.keys(salon.joueurs).length < 2) {
      salon.partieEnCours = false;
    }
  });
});

/**************************************************
 * KUKIPIX - GOOGLE DRIVE
 **************************************************/
app.get("/kukipix", async (req, res) => {
  try {
    if (
      !process.env.GOOGLE_CLIENT_EMAIL ||
      !process.env.GOOGLE_PRIVATE_KEY ||
      !process.env.KUKIPIX_FOLDER_ID
    ) {
      throw new Error("Variables d'environnement manquantes");
    }

  const { google } = require("googleapis");

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});

    const drive = google.drive({ version: "v3", auth });

    const response = await drive.files.list({
      q: `'${process.env.KUKIPIX_FOLDER_ID}' in parents and mimeType contains 'image/'`,
      fields: "files(id,name,mimeType)",
    });

    res.json({
      success: true,
      count: response.data.files.length,
      files: response.data.files,
    });

  } catch (err) {
    console.error("ERREUR KUKIPIX:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**************************************************
 * LANCEMENT
 **************************************************/
nouvelleQuestion();
server.listen(3000, () => {
  console.log("Serveur lance sur le port 3000");
});
