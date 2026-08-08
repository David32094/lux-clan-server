/*
  Capa táctil para la versión alojada: el desplazamiento vertical no activa
  el editor por accidente. Mantener pulsado y arrastrar inicia una edición.
*/
(() => {
  if (!('ontouchstart' in window)) return;

  const HOLD_MS = 340;
  const MOVE_THRESHOLD = 12;

  function bindMobileEditor(canvasId, toCanvasName, downName, moveName) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    canvas.style.touchAction = 'pan-y';
    let state = null;

    const clear = () => {
      if (state?.timer) clearTimeout(state.timer);
      state = null;
    };

    const editAt = (x, y) => {
      const toCanvas = window[toCanvasName];
      const handleDown = window[downName];
      if (typeof toCanvas === 'function' && typeof handleDown === 'function') {
        handleDown(toCanvas({ clientX:x, clientY:y }));
      }
    };

    const moveAt = touch => {
      const toCanvas = window[toCanvasName];
      const handleMove = window[moveName];
      if (typeof toCanvas === 'function' && typeof handleMove === 'function') {
        handleMove(toCanvas(touch));
      }
    };

    // En captura anulamos los listeners antiguos antes de que bloqueen el scroll.
    canvas.addEventListener('touchstart', event => {
      event.stopImmediatePropagation();
      if (event.touches.length !== 1) {
        clear();
        return;
      }

      const touch = event.touches[0];
      const next = { x:touch.clientX, y:touch.clientY, editing:false, scrolling:false, timer:null };
      state = next;
      next.timer = setTimeout(() => {
        if (state !== next || next.scrolling) return;
        next.editing = true;
        editAt(next.x, next.y);
      }, HOLD_MS);
    }, { capture:true, passive:false });

    canvas.addEventListener('touchmove', event => {
      event.stopImmediatePropagation();
      if (event.touches.length !== 1 || !state) return;

      const touch = event.touches[0];
      if (!state.editing) {
        if (Math.hypot(touch.clientX - state.x, touch.clientY - state.y) > MOVE_THRESHOLD) {
          state.scrolling = true;
          clearTimeout(state.timer);
        }
        return; // El navegador recibe el gesto y desplaza la página.
      }

      event.preventDefault();
      moveAt(touch);
    }, { capture:true, passive:false });

    canvas.addEventListener('touchend', clear, { capture:true, passive:true });
    canvas.addEventListener('touchcancel', clear, { capture:true, passive:true });
  }

  document.querySelectorAll('.canvas-hint').forEach(el => {
    el.textContent = 'Desliza para navegar · Mantén pulsado y arrastra para editar';
  });

  bindMobileEditor('c-integ', 'toCanvasInteg', 'handleMouseDownInteg', 'handleMouseMoveInteg');
  bindMobileEditor('c-enfrent', 'toCanvasEnfrent', 'handleMouseDownEnfrent', 'handleMouseMoveEnfrent');
})();
