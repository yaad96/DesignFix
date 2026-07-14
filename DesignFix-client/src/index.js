import React from "react";
import ReactDOM from "react-dom";
import App from "./App";
import {unregister as unregisterServiceWorker} from "./registerServiceWorker";

import { Provider } from "react-redux"

import store from "./reduxStore";
import configureMonaco from "./configureMonaco";

configureMonaco();

ReactDOM.render(
    <Provider store={store}>
        <App />
    </Provider>,
    document.getElementById("root")
);
// This UI mirrors a live IDE session. Cached bundles make a normal refresh and
// a cache-bypassing refresh run different client code, so offline caching is
// intentionally disabled.
unregisterServiceWorker();
