import React from 'react';
import {createRoot} from 'react-dom/client';
import {UpdateNotice} from '../../src/UpdateNotice';
import '../../src/compact.css';
createRoot(document.getElementById('root')!).render(<UpdateNotice visible busy />);
