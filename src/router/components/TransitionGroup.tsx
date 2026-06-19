import { Route, Routes, useLocation } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import { routes, getGuidByPath } from "../routes";
import { getPageTransition, defaultTransitionProps } from "../transition";
import type { TransitionResult } from "../transition";
import { useEffect } from "react";

interface RouterQuery {
  from: string;
  et: string;
  to: string;
}

// 路由状态索引
let stateIdx = history.state?.idx || 0;
const lastQuerysKey = "pixso-d2c-last-querys";
let isFirstRender = true;
let transitionInfo: TransitionResult = {
  props: defaultTransitionProps,
  transition: undefined,
};

const routerBefore = () => {
  const location = useLocation();
  if (isFirstRender) {
    isFirstRender = false;
  } else {
    if (!history.state) return { transitionInfo, location };

    const currentIdx = history.state?.idx || 0;
    const lastQuerys = JSON.parse(
      sessionStorage.getItem(lastQuerysKey) || "[]"
    );

    const isPush = stateIdx < currentIdx;
    stateIdx = currentIdx;

    let transitionVars: any;

    if (isPush) {
      const query = (location.state as RouterQuery) || { from: "", et: "", to: "" };
      const toGuid = getGuidByPath(location.pathname);
      if (toGuid) {
        query.to = toGuid;
      }
      lastQuerys.push(query);
      transitionVars = query;
    } else {
      transitionVars = lastQuerys.pop() || null;
    }

    sessionStorage.setItem(lastQuerysKey, JSON.stringify(lastQuerys));
    if (transitionVars) {
      const { from, et, to } = transitionVars;
      transitionInfo = getPageTransition(from, to, et, isPush ? "push" : "pop");
    }
  }
  return { transitionInfo, location };
};

const PageWrapper = ({ children }: { children: React.ReactNode }) => {
  const location = useLocation();
  const { props, transition } = transitionInfo || {
    props: defaultTransitionProps,
    transition: undefined,
  };

  useEffect(() => {
    return () => {};
  }, []);

  return (
    <motion.div
      key={location.pathname}
      initial={props.initial}
      animate={props.animate}
      exit={props.exit}
      transition={transition}
      style={{
        position: "absolute",
        width: "100%",
        height: "calc(100% - 38px)",
        overflow: "hidden",
        left: 0,
        top: 38,
      }}
    >
      {children}
    </motion.div>
  );
};

const TransitionGroup = () => {
  const { location } = routerBefore();

  return (
    <AnimatePresence initial={false}>
      <Routes location={location} key={location.pathname}>
        {routes.map((route) => (
          <Route
            key={route.path}
            path={route.path}
            element={
              <PageWrapper>
                <route.component />
              </PageWrapper>
            }
          />
        ))}
      </Routes>
    </AnimatePresence>
  );
};

const RouterView = () => {
  return <TransitionGroup />;
};

export default RouterView;
