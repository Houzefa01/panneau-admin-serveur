'use strict';

const zlib = require('zlib');

// Compression gzip légère et SANS dépendance pour les réponses JSON de l'API
// (listings de fichiers, contenu des fichiers ouverts dans l'éditeur, journal…).
// Sur connexion faible/distante, cela réduit nettement les octets transférés
// donc la latence perçue. On n'enveloppe QUE `res.json` : les téléchargements
// bruts et les archives zip (res.download, archive.pipe) ne sont jamais touchés.
// gzip est appelé en asynchrone pour ne pas bloquer la boucle d'événements même
// sur un gros fichier.

const MIN_BYTES = 1024; // en deçà, l'overhead gzip ne vaut pas le coup

function gzipJson() {
  return function (req, res, next) {
    const accepts = String(req.headers['accept-encoding'] || '').includes('gzip');
    const orig = res.json.bind(res);
    res.json = (body) => {
      let text;
      try { text = JSON.stringify(body); } catch (e) { return orig(body); }
      res.setHeader('Vary', 'Accept-Encoding');
      if (!accepts || text === undefined || Buffer.byteLength(text) < MIN_BYTES) {
        return orig(body);
      }
      zlib.gzip(text, (err, buf) => {
        if (err || res.headersSent) { try { return orig(body); } catch (e) { return; } }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', buf.length);
        res.end(buf);
      });
      return res;
    };
    next();
  };
}

module.exports = { gzipJson };
