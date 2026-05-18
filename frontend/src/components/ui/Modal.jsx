export function Modal({ onClose, wide, children }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div 
        className={`modal-container ${wide ? "modal-wide" : ""}`} 
        onClick={(e) => e.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        <div className="modal-body">
          {children}
        </div>
      </div>
    </div>
  );
}