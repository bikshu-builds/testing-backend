const whitelist = [
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8081',
  'http://localhost:9081',
  'http://127.0.0.1:5501',
  'http://localhost:5501',
];

export const corsOptions = {
  // Use a function so process.env.chatte_url is read lazily at request time.
  origin: (origin, callback) => {
    const allowed = process.env.chatte_url;
    // Allow requests with no origin (e.g. mobile apps, curl in dev),
    // or if the origin is in the explicit whitelist or matches chatte_url.
    if (!origin || origin === allowed || whitelist.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin "${origin}" is not allowed`));
    }
  },
  credentials: true,
};
