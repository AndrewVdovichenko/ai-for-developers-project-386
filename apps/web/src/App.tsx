import { MantineProvider } from '@mantine/core';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { BookingPage } from './pages/BookingPage';
import { HomePage } from './pages/HomePage';
import { theme } from './theme';
import { OwnerLoginPage } from './pages/OwnerLoginPage';
import { OwnerPage } from './pages/OwnerPage';

const router = createBrowserRouter([
  { path: '/', element: <HomePage /> },
  { path: '/booking', element: <BookingPage /> },
  { path: '/owner/login', element: <OwnerLoginPage /> },
  { path: '/owner/event-types', element: <OwnerPage /> },
  { path: '/owner/availability', element: <OwnerPage /> },
  { path: '/owner/bookings', element: <OwnerPage /> },
]);

export function App() {
  return (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <RouterProvider router={router} />
    </MantineProvider>
  );
}
