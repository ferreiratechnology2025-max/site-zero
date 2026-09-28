# site-zero — invariantes operacionais

Este repositório hospeda múltiplos sites institucionais de clientes. Cada cliente vive
no seu próprio subprojeto, com sua própria configuração (domínio, projeto Cloudflare
Pages, tokens). Nada de específico de um cliente pertence a este arquivo.

Procedimento detalhado e troubleshooting de deploy: `docs/cloudflare-pages-runbook.md`.

## Infraestrutura já resolvida

Não reabrir decisões técnicas já validadas sem evidência concreta de falha. Um fluxo
com gate PASS rodando em produção é baseline — corrija localmente, não migre, não
reinstale, não redesenhe a arquitetura "para melhorar".

## Deploy

Cada cliente usa **Cloudflare Pages Direct Upload** via `npm run publicar`
(`scripts/publish.mjs`), salvo necessidade comprovada de outra arquitetura. Não trocar
para R2/Workers sem essa necessidade documentada no momento da decisão.

O script de publicação deve ficar pequeno e não "inteligente": ele faz exatamente o que
já funcionou manualmente, nada mais. Wrangler é dependência local do projeto, nunca
global.

## Conta, zona e tokens

Um token que administra Pages não necessariamente enxerga zonas DNS. `GET /zones → 0`
prova apenas que aquele token não tem permissão — não prova que a zona não existe.
Verificar permissões do token antes de concluir qualquer coisa sobre a conta.

Separar tokens por responsabilidade (deploy vs. DNS). Nunca imprimir ou salvar tokens
em arquivo versionado, log, ou `package.json`.

## DNS e domínio

Antes de alterar DNS de qualquer cliente: diagnosticar → provar o problema → fazer a
menor alteração possível. Nunca trocar nameservers, remover ou recriar zona sem esse
diagnóstico prévio.

## Preview ≠ produção

Todo site novo nasce protegido contra indexação (robots.txt, meta robots e header
`X-Robots-Tag`, todos em modo `noindex`). Virar para produção é uma mudança pequena e
explícita nessas três camadas juntas — nunca deixar o preflight de `npm run publicar`
aceitar uma regressão silenciosa desse estado.

## Segurança

Preservar sempre `Content-Security-Policy`, `X-Frame-Options`, `Referrer-Policy`,
`Permissions-Policy`. Nunca enfraquecer esses headers como atalho para resolver um erro
de deploy.

## Segurança de processos

**Nunca usar `taskkill /F /IM node.exe`** — mata todos os processos Node da máquina,
incluindo MCPs e outros serviços do usuário. Encerrar sempre pelo PID específico do
processo que a própria tarefa iniciou.

## Uso de agente/navegador

Quando o bloqueio está no estado real de um painel externo (conta, permissões, zona
visível na UI mas não na API, fluxo que a documentação não cobre), preferir inspecionar
com um agente/navegador em vez de adivinhar via API ou compensar com mudanças
destrutivas.

## Regra principal

Antes de alterar arquitetura, DNS, conta, zona ou método de deploy de um site em
produção: **diagnosticar → provar o problema → fazer a menor alteração possível.**
