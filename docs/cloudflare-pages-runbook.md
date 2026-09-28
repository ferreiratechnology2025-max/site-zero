# Cloudflare Pages — runbook de publicação

Procedimento detalhado e troubleshooting para publicar um site cliente via Cloudflare
Pages Direct Upload. As invariantes que isto implementa estão em `CLAUDE.md` — este
documento é o "como", não o "por quê deve continuar assim".

Este processo foi validado ponta a ponta no primeiro cliente ("Cliente Zero"). Os
valores concretos (domínio, nome de projeto, tokens) pertencem à configuração de cada
subprojeto de cliente, nunca a este arquivo.

## Configuração por cliente

Cada subprojeto de cliente define, fora deste repositório de regras:
- `PAGES_PROJECT` — nome do projeto Cloudflare Pages
- `CANONICAL_URL` — domínio final (`https://.../`)
- `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` — variáveis de ambiente no shell de
  quem publica, nunca em arquivo versionado

## Publicação

```bash
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_API_TOKEN="..."
npm run publicar
```

Fluxo executado por `scripts/publish.mjs`:
```
preflight (arquivos críticos, canonical, WhatsApp/contato, SEO, sitemap, JSON-LD,
           sem placeholders, sem segredos em dist/)
  → wrangler pages deploy dist --project-name <PAGES_PROJECT> --branch main
  → captura da URL de deployment + URL estável (<PAGES_PROJECT>.pages.dev)
  → smoke test remoto (HTTP status + headers de segurança)
  → relatório
```

Se qualquer validação crítica do preflight falhar, o script aborta e não publica.

## Criando um projeto Pages pela primeira vez

```bash
npx wrangler pages project create <PAGES_PROJECT> --production-branch main
```

Versões recentes do Wrangler tentam delegar `pages project create` para o fluxo
unificado "Cloudflare Workers" e falham por falta de Worker script. A própria
mensagem de erro recomenda `--force` para usar o Pages clássico — isso é seguro e
documentado pela ferramenta, não é "inventar sintaxe". Só é necessário uma vez, na
criação do projeto; deploys subsequentes não precisam de `--force`.

## Windows: `spawnSync("npx", ...)` falha com ENOENT

Limitação conhecida do Node: o `CreateProcess` do Windows não executa shims `.cmd`
diretamente. Sintoma: `spawnSync npx ENOENT` mesmo com `npx` funcionando no terminal.

Fix (usado em `scripts/publish.mjs`):
```js
const isWin = process.platform === 'win32';
const spawnBin = isWin ? 'cmd.exe' : 'npx';
const spawnArgs = isWin ? ['/c', 'npx', ...args] : args;
spawnSync(spawnBin, spawnArgs, { cwd, env, encoding: 'utf8' });
```
Evitar `shell: true` genérico (Node emite deprecation warning sobre escaping de args)
— só usar se todos os argumentos forem literais estáticos.

## Diagnosticando "GET /zones → 0"

Sintoma: um token que já comprovadamente administra o projeto Pages (cria projeto, faz
deploy, lista domínios do projeto) retorna 0 zonas em `GET /zones`, mesmo que o domínio
já esteja com nameservers apontando para a Cloudflare.

**Isso não prova que a conta não tem a zona.** Prova só que aquele token não tem
permissão `Zone:Read`. Muitos tokens são criados com escopo restrito só a Pages.

Passo a passo de diagnóstico:
1. `GET /accounts` com o token atual → confirma qual(is) conta(s) ele enxerga.
2. `GET /zones` (sem filtro de nome) com o mesmo token → se o total for 0 mesmo sem
   filtro, é forte indício de token sem permissão de zona (não de zona inexistente).
3. Pedir ao usuário um token novo com escopo `Zone:Read` + `Zone:DNS:Edit` para a zona
   específica.
4. Com o novo token, `GET /zones?name=<dominio>` → deve retornar a zona, com `account.id`
   e `account.name`, confirmando em qual conta ela realmente está.
5. Comparar `account.id` da zona com o `account_id` do token de Pages — se forem iguais,
   o problema era só permissão; se forem diferentes, a zona está em outra conta/login.

## Conectando um custom domain ao projeto Pages

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/pages/projects/<PAGES_PROJECT>/domains" \
  -H "Authorization: Bearer <PAGES_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"<dominio>"}'
```

Mesmo com zona e projeto Pages na mesma conta, a Cloudflare **não cria** o registro DNS
necessário automaticamente. Checar o status retornado — se aparecer
`"error_message": "CNAME record not set"`, criar manualmente:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/dns_records" \
  -H "Authorization: Bearer <DNS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"type":"CNAME","name":"<dominio>","content":"<PAGES_PROJECT>.pages.dev","proxied":true}'
```

Cloudflare faz CNAME flattening automático no apex quando o registro está proxied
(nuvem laranja). Depois de criar o registro, a verificação do domínio no Pages roda em
um job periódico próprio da Cloudflare — não é instantânea; poll
`GET /pages/projects/<PAGES_PROJECT>/domains/<dominio>` a cada ~20s até
`status: "active"`.

## Registrador de domínio (ex.: Registro.br)

Uma vez que os nameservers do registrador apontam para a Cloudflare
(`*.ns.cloudflare.com`), o painel do registrador deixa de ser a fonte de verdade para
DNS. Toda alteração de registro passa a ser feita na Cloudflare. Não editar a zona no
registrador enquanto ela estiver delegada.

## Preview → Produção (indexação)

Estado inicial (preview, protegido):
```
robots.txt              → Disallow: /
meta robots (HTML)       → noindex, nofollow
_headers (X-Robots-Tag)  → noindex, nofollow
```

Estado de produção (depois do domínio final validado):
```
robots.txt              → Allow: /
meta robots (HTML)       → index, follow
_headers                 → remover a linha X-Robots-Tag inteiramente
```

As três camadas mudam juntas, na mesma publicação. O preflight de `scripts/publish.mjs`
deve ser atualizado para exigir explicitamente o estado esperado do momento (bloqueado
durante preview, permitido em produção) — nunca deixar essas checagens no estado antigo
por inércia.

## Smoke test remoto mínimo

Depois de qualquer deploy, validar contra a URL real (estável ou domínio final):
- `/` → 200, headers de segurança presentes
- páginas secundárias (ex. `/privacy`) → 200 (ou redirect de clean-URL do Pages, ex.
  `.html` → sem extensão, que é comportamento padrão, não bug)
- `robots.txt`, `sitemap.xml` → 200, conteúdo consistente com o estado de indexação
  esperado
- assets críticos (CSS, JS, imagens) → 200
- JSON-LD → `JSON.parse` bem-sucedido, sem dados inventados (sem `LocalBusiness`/
  endereço/CNPJ salvo se o cliente fornecer e autorizar explicitamente)
- link de contato (WhatsApp ou equivalente) → presente e correto
