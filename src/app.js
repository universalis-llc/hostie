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
import { exec as execCB } from 'node:child_process';

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
  onMethodNotAllowed(ctx){
    ctx.body = `${ctx.req.method} method not supported by this endpoint`;
  }
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
  if (ctx.protocol !== "https") {
    throw new ErrorWithStatusCode("This endpoint requires TLS. Use https", null, 403);
  }
  await next();
}

router
  // .get('/asset/key', async (ctx) => {
  //   const { uuid, stateless } = getParams(ctx, { uuid: { required: true }, stateless: undefined });

  //   if (stateless) {

  //     const key = await crypto.generateStatelessAssetKey(uuid);
  //     ctx.body = JSON.stringify({
  //       key: {
  //         value: key.toString("hex"),
  //         encoding: 'hex'
  //       }
  //     });
  //   }
  //   else {
  //     try {

  //       const key = await assets.get(`${uuid}.key`);
  //       ctx.body = JSON.stringify({
  //         key: {
  //           value: key.toString("hex"),
  //           encoding: 'hex'
  //         }
  //       });

  //     } catch (e) {
  //       console.debug(e)
  //       if (e.code === 'LEVEL_NOT_FOUND')
  //         throw new ErrorWithStatusCode('no key for asset found', null, 400);
  //       else throw e;
  //     }
  //   }
  // })
  .get('/health', ctx => {
    ctx.status = 200;
    ctx.body = "OK";
  })
  .get('/ssh/token', requireTLS, async ctx => {
    const { id, secret, type } = getParams(ctx, { id: { required: true }, secret: { required: true }, type: { required: true } });

    if (type !== 'host') {
      throw new ErrorWithStatusCode('Only host type tokens are supported', null, 400);
    }

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

    const hostname = `${id.replace(/\./g, '-')}.node.universalis.dev`;

    try {
      const { stdout, stderr } = await exec(`${CONFIG.step.binary} ca token ${hostname} --ca-url=${CONFIG.step.url} --provisioner=${CONFIG.step.provisioner} --ssh --host --not-after 5m --provisioner-password-file=${__dirname}/../provisionerPassword.txt`);
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

  .post('/asset', requireTLS, async ctx => {
    const { id, secret } = getParams(ctx, { id: { required: true }, secret: { required: true }, });

    try {
      const secret = await assets.get(id);
      throw new ErrorWithStatusCode(`asset with id ${id} already exists`, null, 200);
    } catch (e) {
      if (e.code !== 'LEVEL_NOT_FOUND') throw e;
    }


    await assets.put(id, secret);
    console.info(`Registered ${id}`);

    ctx.status = 201;

  })

  .delete('/asset', requireTLS, auth, async ctx => {
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

  .get('/asset', requireTLS, auth, async ctx => {
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

app
  .use(serve('./public'));

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
