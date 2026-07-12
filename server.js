import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";

import apiRouter from "./routes.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get('/', (req, res) => {
  return res.send("Linked Agent is running");
});

// Mount modular subroutes
app.use("/api", apiRouter);

app.listen(PORT, () => {
  console.log(`LinkedAgent backend running at http://localhost:${PORT}`);
});