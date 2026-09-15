import 'dotenv/config';
import { createApp } from './src/app.js';

const port = Number(process.env.PORT || 3000);
const app = await createApp();

app.listen(port, () => {
  console.log(`Manar is available on http://localhost:${port}`);
});
