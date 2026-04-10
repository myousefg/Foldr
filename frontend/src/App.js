import { HashRouter, Routes, Route } from 'react-router-dom';
import { Toaster } from 'sonner';
import { ThemeProvider } from '@/context/ThemeProvider';
import Layout from '@/components/Layout';
import Dashboard from '@/pages/Dashboard';
import RulesManager from '@/pages/RulesManager';
import ActivityLog from '@/pages/ActivityLog';
import Settings from '@/pages/Settings';
import './App.css';

export default function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="foldr-theme">
      <HashRouter>
        <Layout>
          <Routes>
            <Route path="/"         element={<Dashboard/>}   />
            <Route path="/rules"    element={<RulesManager/>} />
            <Route path="/activity" element={<ActivityLog/>}  />
            <Route path="/settings" element={<Settings/>}     />
          </Routes>
        </Layout>
        <Toaster position="bottom-right" richColors closeButton/>
      </HashRouter>
    </ThemeProvider>
  );
}
