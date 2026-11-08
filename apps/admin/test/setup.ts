// jsdom implements no layout, so the scroll helpers the console calls must exist without doing work.
Element.prototype.scrollIntoView = () => {};
