const express = require("express");
const http = require("http");
const path = require("path");
const { google } = require("googleapis");

const app = express();
const server = http.createServer(app);

// =======================
// CONFIG EXPRESS
// =======================
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// =======================
// PAGE TEST KUKIPIX
// =======================
app.get("/kukipix", async (req, res) => {
  try {
    // Vérifications des variables d'environnement
    if (!process.env.GOOGLE_CLIENT_EMAIL) {
      throw new Error("GOOGLE_CLIENT_EMAIL manquant");
    }
    if (!process.env.GOOGLE_PRIVATE_KEY) {
      throw new Error("GOOGLE_PRIVATE_KEY manquant");
    }
    if (!process.env.FOLDER_ID) {
      throw new Error("FOLDER_ID manquant");
    }

    // Auth Google Drive (service account)
    const auth = new google.auth.JWT(
      process.env.GOOGLE_CLIENT_EMAIL,
      null,
      process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      ["https://www.googleapis.com/auth/drive.readonly"]
    );

    const drive = google.drive({
      version: "v3",
      auth
    });

    // Liste des images du dossier
    const response = await drive.files.list({
      q: `'${process.env.FOLDER_ID}' in parents and mimeType contains 'image/'`,
      fields: "files(id,name,thumbnailLink)",
      pageSize: 100
    });

    res.json({
      success: true,
      files: response.data.files || []
    });

  } catch (err) {
    console.error("KUKIPIX ERROR:", err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// =======================
// ROUTE RACINE
// =======================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// =======================
// LANCEMENT SERVEUR
// =======================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Serveur lance sur le port " + PORT);
});
