FROM node:20-alpine

WORKDIR /app

# package-lock.json e' committato e si usa `npm ci`, non `npm install`:
# la build installa le versioni esatte bloccate nel lock, quindi
# ricostruire l'immagine fra tre anni da' lo stesso risultato di oggi.
# Con `npm install` una patch release di una dipendenza puo' cambiare il
# comportamento di un sistema in produzione senza che nessuno abbia
# toccato una riga di codice.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY tools ./tools

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
