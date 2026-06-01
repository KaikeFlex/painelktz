# RobuxCola - Sistema Local de Compra de Robux

## 🚀 Como Usar

### 1. Instalar dependências
```bash
npm install
```

### 2. Configurar o .env
Edite o arquivo `.env`:
```
ROBLOX_USERNAME=seu_usuario_roblox
INITIAL_ROBUX=25000
```

### 3. Iniciar o servidor
```bash
npm start
```

### 4. Acessar
Abra no navegador: http://127.0.0.1:8765/robuxcomprar.html

## 📁 Estrutura
- `server.js` - Servidor HTTP local (porta 8765)
- `robuxcomprar.html` - Interface completa
- `.env` - Configurações (username e robux inicial)
- `package.json` - Dependências do projeto

## ⚙️ API Endpoints
- `/api/local-user` - Retorna dados do usuário configurado no .env
- `/api/roblox-users?keyword=NOME` - Busca usuários do Roblox
