type Props = {
  class?: string;
  text?: string;
  attrs?: Record<string, string | undefined>;
  on?: Record<string, EventListener>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props,
  ...children: Array<Node | string | null | false | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props?.class) node.className = props.class;
  if (props?.text !== undefined) node.textContent = props.text;
  if (props?.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) {
      if (value !== undefined) node.setAttribute(key, value);
    }
  }
  if (props?.on) {
    for (const [type, handler] of Object.entries(props.on)) node.addEventListener(type, handler);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}
