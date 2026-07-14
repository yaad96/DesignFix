import React from 'react';
import ReactDOM from 'react-dom';
import {Provider} from 'react-redux';
import App from './App';
import store from './reduxStore';

// monaco-editor 0.21 exposes a webpack `module` entry but no CommonJS `main`,
// which Jest 26 cannot resolve. The smoke test does not exercise the editor, so
// keep Monaco out of this test's module graph.
jest.mock('monaco-editor', () => ({}), {virtual: true});

const NativeWebSocket = global.WebSocket;

beforeEach(() => {
  global.WebSocket = class MockWebSocket {
    constructor() {
      this.readyState = 1;
    }

    close() {
      this.readyState = 3;
    }
  };
});

afterEach(() => {
  global.WebSocket = NativeWebSocket;
});

it('renders without crashing', () => {
  const div = document.createElement('div');
  ReactDOM.render(
    <Provider store={store}>
      <App />
    </Provider>,
    div
  );
  ReactDOM.unmountComponentAtNode(div);
});
