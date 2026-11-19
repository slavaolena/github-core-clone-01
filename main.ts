#!/usr/bin/env node
// Entry point: start the server
import { createApp } from './app.js';

const app = createApp();
const port = parseInt(process.env.PORT ?? '0', 10) || 0;

app.listen(port, () => {
  console.log(`Server listening on port ${app.address()?.port ?? port}`);
});
