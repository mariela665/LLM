const editorCodigo = document.getElementById('editor');
const capaTextoFantasma = document.getElementById('ghostOverlay');


let vocabulario = new Set();
let unigramas = new Map();
let ngramas = new Map();
let sugerenciasActuales = [];
let indiceSeleccionado = 0;
const MAX_CONTEXTO = 5;
const MAX_TOKENS_COMPLETAR = 10;

const puntuacion = new Set(['(', ')', ',', ';', '=', '*', '<', '>', '+', '!', '-']);

function crearClaveContexto(tokens) {
  return tokens.map(token => token.toLowerCase()).join('\u0001');
}

function agregarNgrama(contexto, siguienteToken) {
  const clave = crearClaveContexto(contexto);
  if (!ngramas.has(clave)) ngramas.set(clave, new Map());
  const siguientesTokens = ngramas.get(clave);
  siguientesTokens.set(siguienteToken, (siguientesTokens.get(siguienteToken) || 0) + 1);
}


function tokenizarSQL(texto) {
  const sinComentarios = texto.replace(/--.*$/gm, '');
  const regex = /'[^']*'|[a-zA-Z_áéíóúÁÉÍÓÚñÑ0-9]+(?:\.[a-zA-Z_0-9]+)?|[(),;=*<>+!-]/g;
  return sinComentarios.match(regex) || [];
}


function entrenarModelo(textoCorpus) {
  const tokens = tokenizarSQL(textoCorpus);

  vocabulario.clear();
  unigramas.clear();
  ngramas.clear();

  let sentencia = [];
  const indexarSentencia = (secuencia) => {
    secuencia.forEach((token, indice) => {
      if (!puntuacion.has(token)) {
        vocabulario.add(token);
        unigramas.set(token, (unigramas.get(token) || 0) + 1);
      }

      for (let tamanioContexto = 1; tamanioContexto <= MAX_CONTEXTO && tamanioContexto <= indice; tamanioContexto++) {
        agregarNgrama(secuencia.slice(indice - tamanioContexto, indice), token);
      }
    });
  };

  tokens.forEach((token) => {
    sentencia.push(token);
    if (token === ';') {
      indexarSentencia(sentencia);
      sentencia = [];
    }
  });
  indexarSentencia(sentencia);

}


async function cargarDocumento() {
  try {
    const respuesta = await fetch('LLMFINETUNNING.txt');
    if (!respuesta.ok) throw new Error('No se encontró LLMFINETUNNING.txt');
    const texto = await respuesta.text();
    entrenarModelo(texto);
    actualizarSugerencias();
  } catch (error) {
    console.error(error);
  }
}

function obtenerCandidatos(historialTokens, prefijo = '') {
  const prefijoNormalizado = prefijo.toLowerCase();
  const maximoContexto = Math.min(MAX_CONTEXTO, historialTokens.length);

  for (let tamanioContexto = maximoContexto; tamanioContexto >= 1; tamanioContexto--) {
    const candidatos = new Map();
    const clave = crearClaveContexto(historialTokens.slice(-tamanioContexto));
    const tokensSiguientes = ngramas.get(clave);
    if (!tokensSiguientes) continue;

    tokensSiguientes.forEach((frecuencia, token) => {
      const tokenNormalizado = token.toLowerCase();
      if (prefijoNormalizado && !tokenNormalizado.startsWith(prefijoNormalizado)) return;

      const puntaje = frecuencia;
      const candidatoExistente = candidatos.get(tokenNormalizado);
      if (!candidatoExistente) {
        candidatos.set(tokenNormalizado, { token, puntaje, mejorPuntaje: puntaje });
      } else {
        candidatoExistente.puntaje += puntaje;
        if (puntaje > candidatoExistente.mejorPuntaje) {
          candidatoExistente.token = token;
          candidatoExistente.mejorPuntaje = puntaje;
        }
      }
    });

    if (candidatos.size > 0) {
      return Array.from(candidatos.values()).sort((a, b) => b.puntaje - a.puntaje);
    }
  }

  if (historialTokens.length === 0) {
    const candidatos = new Map();
    vocabulario.forEach((token) => {
      if (!prefijoNormalizado || token.toLowerCase().startsWith(prefijoNormalizado)) {
        const tokenNormalizado = token.toLowerCase();
        candidatos.set(tokenNormalizado, { token, puntaje: unigramas.get(token) || 1 });
      }
    });
    return Array.from(candidatos.values()).sort((a, b) => b.puntaje - a.puntaje);
  }

  return [];
}

function formatearTokens(tokens) {
  let texto = '';
  let tokenAnterior = '';

  tokens.forEach((token) => {
    if ([',', ')', ';'].includes(token)) {
      texto = texto.trimEnd() + token;
    } else if (tokenAnterior === '(') {
      texto += token;
    } else {
      texto += (texto ? ' ' : '') + token;
    }
    tokenAnterior = token;
  });

  return texto;
}

function construirCompletado(historialTokens, primerToken) {
  const secuenciaCompletada = [primerToken];
  const contexto = [...historialTokens, primerToken];

  while (secuenciaCompletada.length < MAX_TOKENS_COMPLETAR && secuenciaCompletada[secuenciaCompletada.length - 1] !== ';') {
    const siguienteCandidato = obtenerCandidatos(contexto)[0];
    if (!siguienteCandidato) break;
    secuenciaCompletada.push(siguienteCandidato.token);
    contexto.push(siguienteCandidato.token);
  }

  return formatearTokens(secuenciaCompletada);
}


function obtenerPredicciones(textoAntesDelCursor) {
  const tokens = tokenizarSQL(textoAntesDelCursor);
  if (tokens.length === 0) {
    return ['SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM'];
  }

  const terminaEnEspacio = /\s$/.test(textoAntesDelCursor);
  const ultimoToken = tokens[tokens.length - 1];
  const hayTokenParcial = !terminaEnEspacio && !puntuacion.has(ultimoToken);
  const prefijo = hayTokenParcial ? ultimoToken : '';
  const historialTokens = hayTokenParcial ? tokens.slice(0, -1) : tokens;
  const candidatos = obtenerCandidatos(historialTokens, prefijo);

  return candidatos
    .map(candidato => construirCompletado(historialTokens, candidato.token))
    .filter((completado, indice, todos) =>
      todos.findIndex(elemento => elemento.toLowerCase() === completado.toLowerCase()) === indice
    )
    .slice(0, 6);
}

function actualizarSugerencias() {
  const posicionCursor = editorCodigo.selectionStart;
  const textoAntesDelCursor = editorCodigo.value.substring(0, posicionCursor);

  sugerenciasActuales = obtenerPredicciones(textoAntesDelCursor);
  indiceSeleccionado = 0;
  actualizarTextoFantasma();
}

function actualizarTextoFantasma() {
  capaTextoFantasma.textContent = '';

  if (editorCodigo.value.length === 0 || editorCodigo.selectionStart !== editorCodigo.selectionEnd || sugerenciasActuales.length === 0) {
    return;
  }

  const posicionCursor = editorCodigo.selectionStart;
  const textoAntes = editorCodigo.value.substring(0, posicionCursor);
  const coincidencia = textoAntes.match(/[^\s(),;=*<>+!-]+$/);
  const prefijo = /\s$/.test(textoAntes) || !coincidencia ? '' : coincidencia[0];
  const completado = sugerenciasActuales[indiceSeleccionado];
  const textoRestante = prefijo && completado.toLowerCase().startsWith(prefijo.toLowerCase())
    ? completado.slice(prefijo.length)
    : completado;

  if (!textoRestante) return;

  const elementoTextoFantasma = document.createElement('span');
  elementoTextoFantasma.className = 'ghost-text';
  elementoTextoFantasma.textContent = textoRestante;
  capaTextoFantasma.appendChild(document.createTextNode(textoAntes));
  capaTextoFantasma.appendChild(elementoTextoFantasma);
  capaTextoFantasma.appendChild(document.createTextNode(editorCodigo.value.substring(posicionCursor)));
  capaTextoFantasma.style.width = `${editorCodigo.clientWidth}px`;
  capaTextoFantasma.style.height = `${editorCodigo.clientHeight}px`;
  capaTextoFantasma.scrollTop = editorCodigo.scrollTop;
  capaTextoFantasma.scrollLeft = editorCodigo.scrollLeft;
}


function insertarSugerencia(sugerencia) {
  const posicionCursor = editorCodigo.selectionStart;
  const textoAntes = editorCodigo.value.substring(0, posicionCursor);
  const textoDespues = editorCodigo.value.substring(posicionCursor);

  const terminaEnEspacio = /\s$/.test(textoAntes);
  const prefijo = terminaEnEspacio || textoAntes.length === 0
    ? textoAntes
    : textoAntes.replace(/[^\s(),;=*<>+!-]+$/, '');
  const espacioFinal = sugerencia.endsWith(';') ? '' : ' ';
  const nuevoTextoAntes = prefijo + sugerencia + espacioFinal;

  editorCodigo.value = nuevoTextoAntes + textoDespues;
  editorCodigo.focus();
  editorCodigo.setSelectionRange(nuevoTextoAntes.length, nuevoTextoAntes.length);
  actualizarSugerencias();
}


editorCodigo.addEventListener('input', actualizarSugerencias);
editorCodigo.addEventListener('click', actualizarSugerencias);
editorCodigo.addEventListener('keyup', (evento) => {
  if (evento.ctrlKey && (evento.key === 'ArrowRight' || evento.key === 'ArrowLeft')) return;
  actualizarSugerencias();
});
editorCodigo.addEventListener('scroll', () => {
  capaTextoFantasma.scrollTop = editorCodigo.scrollTop;
  capaTextoFantasma.scrollLeft = editorCodigo.scrollLeft;
});

editorCodigo.addEventListener('keydown', (evento) => {
  if (sugerenciasActuales.length === 0) return;

  if (evento.key === 'Tab' || evento.key === 'Enter') {
    evento.preventDefault();
    insertarSugerencia(sugerenciasActuales[indiceSeleccionado]);
  } else if (evento.key === 'ArrowRight' && evento.ctrlKey) {
    evento.preventDefault();
    indiceSeleccionado = (indiceSeleccionado + 1) % sugerenciasActuales.length;
    actualizarTextoFantasma();
  } else if (evento.key === 'ArrowLeft' && evento.ctrlKey) {
    evento.preventDefault();
    indiceSeleccionado = (indiceSeleccionado - 1 + sugerenciasActuales.length) % sugerenciasActuales.length;
    actualizarTextoFantasma();
  }
});

cargarDocumento();