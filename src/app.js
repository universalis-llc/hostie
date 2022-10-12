import Koa from 'koa';
import Router from 'koa-tree-router';
import qrcode from 'qrcode-terminal';
import http from 'http';
import https from 'https';
import { readFileSync } from 'fs';
import { promisify } from 'util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import serve from 'koa-static';
import got from 'got';
import { exec as execCB } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import init, { assets } from './database.js';
import * as crypto from './crypto.js';
import { ErrorWithStatusCode } from './error.js';
import CONFIG from '../config.json' assert {type: "json"};

const exec = promisify(execCB);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEV_MODE = process.env.NODE_ENV === 'development';

const httpsEnabled = (CONFIG.https.key && CONFIG.https.cert) || (CONFIG.https.dev && DEV_MODE);
const devSSL = DEV_MODE && httpsEnabled ? (await import('selfsigned')).generate(undefined, { days: 365 }) : undefined;
const httpsOptions = httpsEnabled ?
  DEV_MODE ?
    {
      key: devSSL.private,
      cert: devSSL.cert
    }
    : {
      key: readFileSync(join(__dirname, '../', CONFIG.https.key)),
      cert: readFileSync(join(__dirname, '../', CONFIG.https.cert)),
    } : undefined;

const app = new Koa();
const router = new Router({
  // Adding this causes static files to be unable to serve
  // onMethodNotAllowed(ctx){
  //   ctx.body = `${ctx.req.method} method not supported by this endpoint`;
  // }
});

console.debug(`HTTPS is ${httpsEnabled ? 'enabled' : 'disabled'}.`);
console.debug(`Environment is ${DEV_MODE ? 'development' : 'production'}.`)

function getParams(ctx, requested) {
  const params = new URLSearchParams(ctx.request.querystring);

  const results = {};
  for (const [name, { required } = {}] of Object.entries(requested)) {
    results[name] = params.get(name);
    // console.debug({name, required});
    if (required && results[name] === null)
      throw new ErrorWithStatusCode(`query parameter required but not provided: "${name}"`, null, 400);
  }
  return results;
}

async function auth(ctx, next) {
  let [type, token] = ctx.header.authorization?.split(' ') ?? [undefined, undefined];
  if (typeof type === 'undefined') {
    throw new ErrorWithStatusCode('Authorization header required', null, 401);
  }
  type = type.toLowerCase();
  if (type !== 'totp' && type !== 'hotp') {
    throw new ErrorWithStatusCode('HOTP and TOTP are the only supported authorization header scheme', null, 401);
  }

  if (!token) {
    throw new ErrorWithStatusCode('HOTP and TOTP token data not provided', null, 401);
  }

  try {
    await crypto.validateToken(token, type);
  } catch (e) {
    if (e.message === "Invalid token" || e.message === 'Expired token')
      throw new ErrorWithStatusCode(e.message, null, 401);
    else
      throw e;
  }
  await next();
}

async function requireTLS(ctx, next) {
  if (ctx.protocol !== "https" && ctx.header['x-forwarded-proto'] !== "https") {
    throw new ErrorWithStatusCode("This endpoint requires TLS. Use https.", null, 403);
  }
  await next();
}

async function secret(ctx, next) {
  const id = getId(ctx);
  const { secret } = getParams(ctx, { secret: { required: true } });

  // Try to get storedSecret for this id
  let storedSecret;
  try {
    storedSecret = await assets.get(id);
  } catch (e) {
    if (e.code !== 'LEVEL_NOT_FOUND') throw e;
    throw new ErrorWithStatusCode(`asset with id "${id}" does not exist`, null, 400);
  }

  // Check if provided secret is valid
  if (storedSecret !== secret) {
    throw new ErrorWithStatusCode("Invalid secret", null, 400);
  }

  ctx.deviceId = id;

  await next();
}

function getId(ctx) {
  let ip = ctx.header['x-forwarded-for'] || ctx.request.ip;
  return ip.toLowerCase().replace(/[\.:\s]/g, '-').replace(/^\-+/, '');
}

async function registerAsset(id, secret, ip) {
  await assets.put(id, secret);
  console.info(`Registered ${id}`, data);
}

router
  .get('/api/v1/health', ctx => {
    ctx.status = 200;
    ctx.body = "OK";
  })
  .get('/api/v1/ssh/token', requireTLS, secret, async ctx => {
    const { type } = getParams(ctx, { type: { required: true } });

    if (type !== 'host') {
      throw new ErrorWithStatusCode('Only host type tokens are supported', null, 400);
    }

    const hostname = `${ctx.deviceId}.node.universalis.dev`;

    try {
      const { stdout, stderr } = await exec(`${CONFIG.step.binary} ca token ${hostname} --ca-url=${CONFIG.step.url} --provisioner=${CONFIG.step.provisioner} --ssh --host --not-after 5m --provisioner-password-file=${__dirname}/../provisionerPassword.txt --root=${__dirname}/../${CONFIG.step.rootCAPath}`);
      if (!stdout) {
        console.error(stderr);
        throw new ErrorWithStatusCode("Unknown step ca token request error, see logs", null, 500);
      }
      ctx.status = 200;
      ctx.body = stdout;
    } catch (e) {
      console.error(e);
      throw new ErrorWithStatusCode("Unknown step ca token request error, see logs", null, 500);
    }

  })
  .get('/api/v1/ssh/ssh_host_ecdsa_key', requireTLS, secret, async ctx => {
    const hostname = `${ctx.deviceId}.node.universalis.dev`;

    const outputPath = path.join(tmpdir(), hostname);
    await Promise.all([
      fs.rm(outputPath, { force: true }),
      fs.rm(outputPath + '-cert.pub', { force: true }),
      fs.rm(outputPath + '.pub', { force: true })
    ]);
    try {
      const command = `${CONFIG.step.binary} ssh certificate "${hostname}" ${outputPath} --ca-url=${CONFIG.step.url} --provisioner=${CONFIG.step.provisioner} --host --provisioner-password-file=${__dirname}/../provisionerPassword.txt --no-password --insecure --root=${__dirname}/../${CONFIG.step.rootCAPath}`;

      const { stdout, stderr } = await exec(command);
      try {
        await fs.stat(outputPath);
      } catch (e) {
        console.error(stdout, stderr);
        throw new ErrorWithStatusCode("Unknown step ca token request error, see logs", null, 500);
      }
      ctx.status = 200;
      ctx.body = await fs.readFile(outputPath);
      await fs.rm(outputPath);
    } catch (e) {
      console.error(e);
      throw new ErrorWithStatusCode("Unknown step ca token request error, see logs", null, 500);
    }

  })
  .get('/api/v1/ssh/ssh_host_ecdsa_key-cert.pub', requireTLS, secret, async ctx => {
    const hostname = `${ctx.deviceId}.node.universalis.dev`;
    const outputPath = path.join(tmpdir(), hostname) + '-cert.pub';

    try {
      await fs.stat(outputPath);
    } catch (e) {
      throw new ErrorWithStatusCode("file not prepared yet", null, 428);
    }

    ctx.body = await fs.readFile(outputPath);
    await fs.rm(outputPath);
    ctx.status = 200;
  })

  .post('/api/v1/asset', requireTLS, async ctx => {
    const id = getId(ctx);
    const { secret } = getParams(ctx, { secret: { required: true }, });

    try {
      await assets.get(id);
      throw new ErrorWithStatusCode(`asset with id ${id} already exists`, null, 200);
    } catch (e) {
      if (e.code !== 'LEVEL_NOT_FOUND') throw e;
    }

    await registerAsset(id, secret, ctx.request.ip);

    ctx.status = 201;

  })

  .delete('/api/v1/asset', requireTLS, auth, async ctx => {
    const { id } = getParams(ctx, { id: { required: true } });
    try {
      await assets.get(id);
      await assets.del(id);
      ctx.status = 204;
    } catch (e) {
      if (e.code !== 'LEVEL_NOT_FOUND') throw e;
      throw new ErrorWithStatusCode(`asset "${id}" does not exist`, null, 400);
    }
  })

  .get('/api/v1/asset', requireTLS, auth, async ctx => {
    const keys = await assets.keys({ limit: 100 }).all();

    ctx.body = JSON.stringify(keys);
  })

// Error handling
app.use(async (ctx, next) => {
  const ip = ctx.ips.length > 0 ? ctx.ips[ctx.ips.length - 1] : ctx.ip;
  try {
    await next();
    if (ctx.status === 404) {
      console.warn(`[E][S:${ip}][PATH:${ctx.originalUrl}]`, 'Not Found');
      ctx.throw(404);
    };
  } catch (err) {

    if (!(err instanceof ErrorWithStatusCode)) throw err;
    console.warn(`[E][S:${ip}][PATH:${ctx.originalUrl}]`, err.toString());

    if (err.statusCode) ctx.status = err.statusCode;
    ctx.body = JSON.stringify({ error: err.toString() });
  }
});

app
  .use(router.routes())
  // Allow hidden to serve .well-known files for domain validation
  // .use(serve('./public', { hidden: true }));

async function main() {
  await init();

  const totpUri = crypto.totp.toString();
  console.info('TOTP QR code:', totpUri);
  qrcode.generate(totpUri, { small: true });
  const hotpUri = crypto.hotp.toString();
  console.info('HOTP QR code:', hotpUri);
  qrcode.generate(hotpUri, { small: true });

  http.createServer(app.callback()).listen(CONFIG.http.port);
  console.info(`Listening on :${CONFIG.http.port}`);
  if (httpsEnabled) {
    https.createServer(httpsOptions, app.callback()).listen(CONFIG.https.port);
    console.info(`Listening on :${CONFIG.https.port}`);
  }
}

main().catch(console.error);
